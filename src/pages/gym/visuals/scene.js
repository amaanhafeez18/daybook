// Turns a solved skeleton into a flat list of shapes (a "scene") that the SVG renderer draws in
// order. Pure: the tests and the gallery inspect scenes directly.
//
// Shapes: seg (round-capped line), dot (filled circle), ring (stroked circle, optional fill), poly
// (filled polygon), ell (rotated ellipse). Each has a `role` the stylesheet colours: body/far
// (the figure, near and far side), hot/warm (primary/secondary muscles, accent), tint (whole-body
// exercises), gear/plate/pad/frame (equipment), thin (cables and bands), ground, ghost (reduced
// motion's start pose).
import { GROUND, LEN, add, dir } from './rig.js'

export const W = { trunk: 9.4, upperArm: 4.6, foreArm: 3.9, hand: 2.3, thigh: 6.6, shin: 5, foot: 2.8, neck: 3.6 }

export const seg = (a, b, w, role) => ({ k: 'seg', a, b, w, role })
export const dot = (c, r, role) => ({ k: 'dot', c, r, role })
export const ring = (c, r, w, role, fill) => ({ k: 'ring', c, r, w, role, fill })
export const poly = (pts, role) => ({ k: 'poly', pts, role })
export const ell = (c, rx, ry, rot, role) => ({ k: 'ell', c, rx, ry, rot, role })

const DEG = 180 / Math.PI
const rotOf = (v) => Math.atan2(v[1], v[0]) * DEG

// A point in the trunk's own frame: u along hip → shoulder, n toward the front (side view) or the
// figure's right (front view).
function trunkPoint(skel, u, n) {
  const { joints, up, frontDir, trunkScale } = skel
  const across = frontDir || dir(skel.angles.trunk - 90)
  return add(add(joints.hip, up, u * trunkScale), across, n)
}

// Side-view torso: chest in front, a flat back, a hint of the glutes.
const SIDE_TORSO = [[-1, 3.4], [6, 4], [12, 4.3], [17.5, 5], [21, 4.5], [23.6, 2.3], [24.2, -0.8], [23, -3.6], [18, -4.6], [11, -4], [6, -3.6], [1, -4.6], [-2.2, -3.4], [-3, 0]]
const FRONT_TORSO = [[-2.8, -5.4], [1.5, -6.6], [8, -5.6], [15, -7.6], [20.2, -8.8], [23, -7.2], [24, -2.6], [24, 2.6], [23, 7.2], [20.2, 8.8], [15, 7.6], [8, 5.6], [1.5, 6.6], [-2.8, 5.4]]

function limbSegs(out, j, names, role, overlay) {
  const [root, mid, end] = names
  const isLeg = root.startsWith('hip')
  out.push(seg(j[root], j[mid], isLeg ? W.thigh : W.upperArm, role))
  out.push(seg(j[mid], j[end], isLeg ? W.shin : W.foreArm, role))
  if (overlay) out.push(...overlay)
}

// ---- muscles on the figure -------------------------------------------------------------------

// Where each muscle sits on the side-view torso: [u, n, half-length, half-width].
const SIDE_TORSO_MUSCLES = {
  chest: [[17, 2.7, 4.4, 2.2]],
  abs: [[7.5, 2.4, 5.2, 1.7]],
  lats: [[13.5, -2.3, 5.8, 2.1]],
  upper_back: [[19.2, -2.5, 3.8, 2]],
  traps: [[23, -1.6, 2.6, 2.3]],
  lower_back: [[5.5, -2.4, 4, 1.6]],
  glutes: [[-0.4, -2.8, 3.2, 2.6]],
}
const FRONT_TORSO_MUSCLES = {
  chest: [[17.4, 3.5, 2.8, 3.2], [17.4, -3.5, 2.8, 3.2]],
  abs: [[8.2, 0, 6, 2.6]],
  lats: [[13.5, 6.6, 4.2, 1.3], [13.5, -6.6, 4.2, 1.3]],
  traps: [[22.6, 4.2, 1.4, 2.6], [22.6, -4.2, 1.4, 2.6]],
  upper_back: [[22.6, 4.2, 1.4, 2.6], [22.6, -4.2, 1.4, 2.6]],
  abductors: [[0, 6.2, 2.6, 1.8], [0, -6.2, 2.6, 1.8]],
}

// A band along part of a limb segment (t0..t1 of the way from a to b), shifted `offset` along the
// unit vector `normal`, so it covers one side of the limb: the biceps, not the triceps.
function band(a, b, t0, t1, w, offset = 0, normal = [0, 0]) {
  const v = [b[0] - a[0], b[1] - a[1]]
  const p = (t) => add([a[0] + v[0] * t, a[1] + v[1] * t], normal, offset)
  return seg(p(t0), p(t1), w, '')
}

// In a side view a joint flexes toward dir(angle + 90) of its upper segment: the front of the
// upper arm (biceps) and thigh (quads); the opposite side is the triceps, hamstrings and calves.
const flexNormal = (p, q) => dir(Math.atan2(q[0] - p[0], q[1] - p[1]) * DEG + 90)
const neg = (v) => [-v[0], -v[1]]

function sideOverlays(skel, muscles, far) {
  const j = skel.joints
  const s = far ? '2' : ''
  const out = { torso: [], arm: [], leg: [] }
  const roleOf = (id) => (muscles.primary.has(id) ? (far ? 'hotFar' : 'hot') : muscles.secondary.has(id) ? (far ? 'warmFar' : 'warm') : null)
  const add2 = (list, id, shape) => {
    const role = roleOf(id)
    if (role) list.push({ ...shape, role })
  }
  if (!far) {
    for (const [id, spots] of Object.entries(SIDE_TORSO_MUSCLES)) {
      for (const [u, n, half, across] of spots) {
        const c = trunkPoint(skel, u, n)
        add2(out.torso, id, ell(c, half * skel.trunkScale, across, rotOf(skel.up), ''))
      }
    }
  }
  const shoulder = j[`shoulder${s}`] || j.shoulder
  const elbow = j[`elbow${s}`]
  const hand = j[`hand${s}`]
  const hipJ = j[`hipJ${s}`] || j.hip
  const knee = j[`knee${s}`]
  const ankle = j[`ankle${s}`]
  const arm = flexNormal(shoulder, elbow)
  const thigh = flexNormal(hipJ, knee)
  const shin = flexNormal(knee, ankle)
  add2(out.arm, 'shoulders', dot(shoulder, 3.1, ''))
  add2(out.arm, 'biceps', band(shoulder, elbow, 0.22, 0.86, 2.5, 1.05, arm))
  add2(out.arm, 'triceps', band(shoulder, elbow, 0.22, 0.86, 2.5, 1.05, neg(arm)))
  add2(out.arm, 'forearms', band(elbow, hand, 0.12, 0.78, 2.7))
  add2(out.leg, 'quads', band(hipJ, knee, 0.16, 0.9, 3.4, 1.45, thigh))
  add2(out.leg, 'hamstrings', band(hipJ, knee, 0.16, 0.9, 3.4, 1.45, neg(thigh)))
  add2(out.leg, 'adductors', band(hipJ, knee, 0.12, 0.62, 3))
  add2(out.leg, 'abductors', dot(hipJ, 3, ''))
  add2(out.leg, 'calves', band(knee, ankle, 0.1, 0.58, 3, 1, neg(shin)))
  return out
}

function frontOverlays(skel, muscles) {
  const j = skel.joints
  const out = { torso: [], arm: [], leg: [] }
  const roleOf = (id) => (muscles.primary.has(id) ? 'hot' : muscles.secondary.has(id) ? 'warm' : null)
  const put = (list, id, shape) => {
    const role = roleOf(id)
    if (role) list.push({ ...shape, role })
  }
  for (const [id, spots] of Object.entries(FRONT_TORSO_MUSCLES)) {
    for (const [u, n, half, across] of spots) put(out.torso, id, ell(trunkPoint(skel, u, n), half * skel.trunkScale, across, rotOf(skel.up), ''))
  }
  for (const s of ['', '2']) {
    const shoulder = j[`shoulder${s}`]
    const elbow = j[`elbow${s}`]
    const hand = j[`hand${s}`]
    const hipJ = j[`hipJ${s}`]
    const knee = j[`knee${s}`]
    const ankle = j[`ankle${s}`]
    // Unit normal of the thigh pointing toward the body's midline, for the inner thigh.
    const v = [knee[0] - hipJ[0], knee[1] - hipJ[1]]
    const len = Math.hypot(v[0], v[1]) || 1
    let inner = [-v[1] / len, v[0] / len]
    if (inner[0] * (j.hip[0] - hipJ[0]) + inner[1] * (j.hip[1] - hipJ[1]) < 0) inner = neg(inner)
    put(out.arm, 'shoulders', dot(shoulder, 3.2, ''))
    put(out.arm, 'biceps', band(shoulder, elbow, 0.24, 0.86, 2.6))
    put(out.arm, 'triceps', band(shoulder, elbow, 0.24, 0.86, 2.6))
    put(out.arm, 'forearms', band(elbow, hand, 0.12, 0.78, 2.6))
    put(out.leg, 'quads', band(hipJ, knee, 0.14, 0.9, 3.6, 0.3, neg(inner)))
    put(out.leg, 'adductors', band(hipJ, knee, 0.1, 0.62, 2.4, 1.9, inner))
    // A thigh turned toward the viewer is too short for a band: mark the inside of the knee too.
    put(out.leg, 'adductors', dot(add(knee, inner, 2.4), 2, ''))
    put(out.leg, 'hamstrings', band(hipJ, knee, 0.14, 0.9, 3.4))
    put(out.leg, 'calves', band(knee, ankle, 0.1, 0.58, 3))
    put(out.leg, 'glutes', dot(hipJ, 3.2, ''))
  }
  return out
}

// Sets of muscle ids from an exercise ({ primary, secondary }).
export function muscleSets(exercise) {
  const primary = new Set()
  const secondary = new Set()
  if (exercise && typeof exercise.primary === 'string') primary.add(exercise.primary)
  for (const id of Array.isArray(exercise?.secondary) ? exercise.secondary : []) if (typeof id === 'string' && !primary.has(id)) secondary.add(id)
  return { primary, secondary }
}

// The figure for one solved pose, with equipment layers: gear.back (behind everything), gear.far
// (after the far limbs), gear.mid (after the torso and near leg), gear.front (on top).
// Whole-body lifts tint the whole figure; for cardio the legs/arms it lists stand out instead.
export function figureScene(skel, { muscles: given = muscleSets(null), gear = {}, ghost = false } = {}) {
  const j = skel.joints
  const out = []
  const whole = given.primary.has('full_body')
  const muscles = given.primary.has('cardio') ? { primary: given.secondary, secondary: new Set() } : given
  const bodyRole = ghost ? 'ghost' : whole ? 'tint' : 'body'
  const farRole = ghost ? 'ghost' : whole ? 'tint' : 'far'
  const overlays = (fn, ...args) => (ghost ? { torso: [], arm: [], leg: [] } : fn(...args))
  const push = (list) => list && out.push(...list)

  push(gear.back)

  if (skel.view === 'front') {
    const over = overlays(frontOverlays, skel, muscles)
    // Legs, torso, head, then arms on top.
    for (const s of ['2', '']) {
      limbSegs(out, j, [`hipJ${s}`, `knee${s}`, `ankle${s}`], bodyRole)
      out.push(seg(j[`ankle${s}`], add(j[`ankle${s}`], [s ? -1.6 : 1.6, 1.4]), W.foot, bodyRole))
    }
    push(over.leg)
    push(gear.far)
    out.push(poly(FRONT_TORSO.map(([u, n]) => trunkPoint(skel, u, n)), bodyRole))
    out.push(seg(j.neck, add(j.neck, skel.up, 2.4), W.neck, bodyRole))
    out.push(dot(j.head, LEN.head, bodyRole), ring(j.head, LEN.head + 0.5, 1, 'cut'))
    push(over.torso)
    push(gear.mid)
    for (const s of ['2', '']) {
      limbSegs(out, j, [`shoulder${s}`, `elbow${s}`, `hand${s}`], bodyRole)
      out.push(dot(j[`hand${s}`], W.hand, bodyRole))
    }
    push(over.arm)
    push(gear.front)
    return out
  }

  const near = overlays(sideOverlays, skel, muscles, false)
  const far = overlays(sideOverlays, skel, muscles, true)
  // Far side first (behind the body).
  limbSegs(out, j, ['hip', 'knee2', 'ankle2'], farRole)
  out.push(seg(j.heel2, j.toe2, W.foot, farRole))
  push(far.leg)
  limbSegs(out, j, ['shoulder', 'elbow2', 'hand2'], farRole)
  out.push(dot(j.hand2, W.hand, farRole))
  push(far.arm)
  push(gear.far)
  // Torso, neck, head (with a small nose so it's clear which way the figure faces).
  out.push(poly(SIDE_TORSO.map(([u, n]) => trunkPoint(skel, u, n)), bodyRole))
  out.push(seg(add(j.neck, skel.up, -1.2), j.head, W.neck, bodyRole))
  out.push(dot(j.head, LEN.head, bodyRole), ring(j.head, LEN.head + 0.5, 1, 'cut'))
  const face = dir(skel.angles.trunk + skel.headTilt - 90)
  out.push(dot(add(j.head, face, 4.6), 1.3, bodyRole))
  push(near.torso)
  // Near leg, then near arm on top.
  limbSegs(out, j, ['hip', 'knee', 'ankle'], bodyRole)
  out.push(seg(j.heel, j.toe, W.foot, bodyRole))
  push(near.leg)
  push(gear.mid)
  limbSegs(out, j, ['shoulder', 'elbow', 'hand'], bodyRole)
  if (j.fist) out.push(seg(j.hand, j.fist, W.hand * 1.5, bodyRole))
  else out.push(dot(j.hand, W.hand, bodyRole))
  push(near.arm)
  push(gear.front)
  return out
}

// ---- equipment pieces ------------------------------------------------------------------------

export const PLATE_R = 8.2

export function barbell(c, r = PLATE_R) {
  return [ring(c, r, 1.5, 'gear', 'plate'), dot(c, 1.6, 'gear')]
}

// A dumbbell seen at a slight angle: two heads and the handle.
export function dumbbell(c, small = false) {
  const k = small ? 0.8 : 1
  const v = [1.7 * k, -1.1 * k]
  return [seg(add(c, v, -1), add(c, v), 1.4 * k, 'gear'), dot(add(c, v, -1.25), 2.5 * k, 'gear'), dot(add(c, v, 1.25), 2.5 * k, 'gear')]
}

export function kettlebell(hand, down) {
  return [ring(add(hand, down, 1.3), 1.6, 1, 'gear'), dot(add(hand, down, 4.7), 3.5, 'gear')]
}

// Cable column with its pulley, and the cable from the pulley to the handle.
export function cableColumn(x, top = 8) {
  return [seg([x, top], [x, GROUND], 3, 'frame')]
}

export function cable(pulley, handle) {
  return [seg(pulley, handle, 0.9, 'thin'), ring(pulley, 1.9, 1.1, 'gear', 'plate'), dot(handle, 1.5, 'gear')]
}

export function pad(a, b, w = 4) {
  return seg(a, b, w, 'pad')
}

export function post(a, b, w = 1.8) {
  return seg(a, b, w, 'frame')
}

// A pad lying along the trunk on its back (or front, side = 1) surface, from u0 to u1.
export function trunkPad(skel, u0, u1, side = -1, w = 4) {
  const offset = side * (4.6 + w / 2)
  return pad(trunkPoint(skel, u0, offset), trunkPoint(skel, u1, offset), w)
}

export { trunkPoint }

// ---- bounds ----------------------------------------------------------------------------------

export function sceneBounds(items, box = [Infinity, Infinity, -Infinity, -Infinity]) {
  const grow = (p, r) => {
    box[0] = Math.min(box[0], p[0] - r)
    box[1] = Math.min(box[1], p[1] - r)
    box[2] = Math.max(box[2], p[0] + r)
    box[3] = Math.max(box[3], p[1] + r)
  }
  for (const item of items) {
    if (item.k === 'seg') {
      grow(item.a, item.w / 2)
      grow(item.b, item.w / 2)
    } else if (item.k === 'dot' || item.k === 'ring') grow(item.c, item.r + (item.w || 0) / 2)
    else if (item.k === 'ell') grow(item.c, Math.max(item.rx, item.ry))
    else if (item.k === 'poly') for (const p of item.pts) grow(p, 0.6)
  }
  return box
}

// A square box around `bounds` with some padding, never smaller than `min`.
export function squareBox(bounds, pad = 3, min = 30) {
  let [x0, y0, x1, y1] = bounds
  if (!Number.isFinite(x0)) return [0, 0, 100, 100]
  x0 -= pad
  y0 -= pad
  x1 += pad
  y1 += pad
  const size = Math.max(min, x1 - x0, y1 - y0)
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  return [cx - size / 2, cy - size / 2, size, size]
}

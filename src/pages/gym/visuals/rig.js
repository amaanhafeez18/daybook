// Pose rig for the exercise figures: body proportions, joint maths and keyframe interpolation.
// Pure module (no React, no DOM): the figure component, the review gallery and the tests share it.
//
// Coordinates: a 100×100 box, y down, the floor at GROUND. Angles are degrees measured from
// straight down, turning toward the figure's front: 0 = down, 90 = forward (+x in a side view),
// 180 = up, -90 = backward. Segment angles are absolute (not relative to the parent joint), which
// keeps lying, hanging and standing poses equally easy to write.
//
// A pose: { anchor, at, trunk, head, arm, arm2, leg, leg2, fs }
// - anchor/at: which joint sits where ('hip' by default); e.g. the toe on the floor, the hand on a bar.
// - trunk: hip → shoulder angle (180 = upright); head: tilt relative to the trunk.
// - arm: [upper, fore] angles, or { to, bend } to reach a point (two-bone IK; bend ±1 picks the
//   elbow side). leg: [thigh, shin, foot] or { to, bend, foot }. arm2/leg2 = the far side (side view)
//   or the left side (front view); they default to the near side (mirrored in a front view).
// - fs: foreshortening, e.g. { arm: [1, 0.4], trunk: 0.7 }, for limbs turned toward the viewer.
// A target is [x, y], { c: [x, y], r, a } (a point on a circle/ellipse, so pedals go round), or
// { from: 'shoulder', d: [dx, dy] } relative to a joint already placed.

const RAD = Math.PI / 180

export const GROUND = 92
export const LEN = { trunk: 23, shoulderDrop: 1.6, upperArm: 13, foreArm: 12, thigh: 17, shin: 16.5, foot: 6, heel: 1.6, neck: 2.6, head: 5 }
// Front view: half the distance between the shoulder joints and between the hip joints.
export const HALF = { shoulder: 7.4, hip: 4.2 }

export const LIMBS = ['arm', 'arm2', 'leg', 'leg2']
const SIDE_ANCHORS = ['hip', 'shoulder', 'neck', 'hand', 'hand2', 'elbow', 'elbow2', 'knee', 'knee2', 'ankle', 'ankle2', 'toe', 'toe2', 'heel', 'heel2']

export const dir = (deg) => [Math.sin(deg * RAD), Math.cos(deg * RAD)]
export const angleOf = (dx, dy) => Math.atan2(dx, dy) / RAD
export const add = (p, v, k = 1) => [p[0] + v[0] * k, p[1] + v[1] * k]
export const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1])
export const lerp = (a, b, t) => a + (b - a) * t
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const num = (value, fallback) => (Number.isFinite(value) ? value : fallback)

// Wraps an angle into (-180, 180].
export function normDeg(deg) {
  const d = ((((deg + 180) % 360) + 360) % 360) - 180
  return d === -180 ? 180 : d
}

// Two-bone IK: from root toward target with segment lengths l1, l2. A target out of reach gets a
// straight limb pointing at it.
export function reach(root, target, l1, l2, bend = 1) {
  const dx = target[0] - root[0]
  const dy = target[1] - root[1]
  const d = clamp(Math.hypot(dx, dy), Math.abs(l1 - l2) + 1e-6, l1 + l2 - 1e-6)
  const base = angleOf(dx, dy)
  const inner = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1)) / RAD
  const a1 = base + (bend >= 0 ? inner : -inner)
  const mid = add(root, dir(a1), l1)
  const a2 = angleOf(target[0] - mid[0], target[1] - mid[1])
  return { a1, a2, mid, end: add(mid, dir(a2), l2) }
}

// `frame` = { up, across } of the trunk, for targets given in the trunk's own frame
// ({ from, local: [along, across] }: a bar on the back, hands at the chest).
export function targetPoint(target, joints, frame) {
  if (Array.isArray(target)) return target
  if (target && Array.isArray(target.c)) {
    const r = Array.isArray(target.r) ? target.r : [num(target.r, 0), num(target.r, 0)]
    const d = dir(num(target.a, 0))
    return [target.c[0] + d[0] * r[0], target.c[1] + d[1] * r[1]]
  }
  if (target && typeof target.from === 'string' && joints[target.from]) {
    if (Array.isArray(target.local) && frame) return add(add(joints[target.from], frame.up, num(target.local[0], 0)), frame.across, num(target.local[1], 0))
    return add(joints[target.from], target.d || [0, 0])
  }
  return null
}

// The spec for a limb, falling back to the near side for arm2/leg2.
export function limbSpec(pose, name) {
  const own = pose[name]
  if (own !== undefined) return own
  return name.endsWith('2') ? pose[name.slice(0, -1)] : undefined
}

const isIk = (spec) => Boolean(spec) && !Array.isArray(spec) && typeof spec === 'object'

const LIMB_PARTS = {
  arm: { root: 'shoulder', mid: 'elbow', end: 'hand', l1: LEN.upperArm, l2: LEN.foreArm },
  arm2: { root: 'shoulder2', mid: 'elbow2', end: 'hand2', l1: LEN.upperArm, l2: LEN.foreArm },
  leg: { root: 'hipJ', mid: 'knee', end: 'ankle', l1: LEN.thigh, l2: LEN.shin },
  leg2: { root: 'hipJ2', mid: 'knee2', end: 'ankle2', l1: LEN.thigh, l2: LEN.shin },
}

// Places one limb (angles or IK) and, for legs, the foot. Angles become world angles through
// `world(a) = base + side * a`: identity in a side view; in a front view they're relative to the
// trunk, mirrored for the left side (side = -1). Recorded angles are world angles.
function placeLimb(joints, angles, name, spec, fs, base, side, frame) {
  const part = LIMB_PARTS[name]
  const root = joints[part.root]
  const scale = Array.isArray(fs) ? fs : [1, 1]
  const l1 = part.l1 * num(scale[0], 1)
  const l2 = part.l2 * num(scale[1], 1)
  const world = (a) => base + side * a
  let a1
  let a2
  if (isIk(spec)) {
    const target = targetPoint(spec.to, joints, frame) || add(root, [0, 1], l1 + l2)
    const solved = reach(root, target, l1, l2, side * num(spec.bend, 1))
    a1 = solved.a1
    a2 = solved.a2
  } else {
    a1 = world(num(spec?.[0], 0))
    a2 = world(num(spec?.[1], spec?.[0] ?? 0))
  }
  joints[part.mid] = add(root, dir(a1), l1)
  joints[part.end] = add(joints[part.mid], dir(a2), l2)
  angles[name] = [a1, a2]
  if (name.startsWith('leg')) {
    const foot = world(num(isIk(spec) ? spec.foot : spec?.[2], 90))
    const suffix = name === 'leg2' ? '2' : ''
    joints[`toe${suffix}`] = add(joints[part.end], dir(foot), LEN.foot)
    joints[`heel${suffix}`] = add(joints[part.end], dir(foot), -LEN.heel)
    angles[name].push(foot)
  }
}

// Reflects a point across the line through `origin` along unit vector `axis`.
function reflect(point, origin, axis) {
  const v = [point[0] - origin[0], point[1] - origin[1]]
  const along = v[0] * axis[0] + v[1] * axis[1]
  return [origin[0] + 2 * along * axis[0] - v[0], origin[1] + 2 * along * axis[1] - v[1]]
}

function translate(joints, shift) {
  for (const key of Object.keys(joints)) joints[key] = add(joints[key], shift)
}

// Joint positions for a pose. Limbs given as angles are placed first, then the whole body moves so
// the anchor joint sits at `at`, then IK limbs reach for their (world) targets.
export function solvePose(pose, view = 'side') {
  const front = view === 'front'
  const trunk = num(pose.trunk, 180)
  const fs = pose.fs || {}
  const trunkScale = num(fs.trunk, 1)
  const headTilt = num(pose.head, 0)
  const up = dir(trunk)
  // Side view: toward the chest. Front view: toward the figure's right (screen right when upright).
  const across = dir(trunk - 90)
  const frame = { up, across }
  const joints = { hip: [0, 0] }
  // `lift` raises the shoulders along the trunk (a shrug).
  joints.shoulder = add(joints.hip, up, (LEN.trunk - LEN.shoulderDrop) * trunkScale + num(pose.lift, 0))
  joints.neck = add(joints.hip, up, LEN.trunk * trunkScale)
  joints.head = add(joints.neck, dir(trunk + headTilt), LEN.neck + LEN.head)
  if (front) {
    joints.shoulder2 = add(joints.shoulder, across, -HALF.shoulder)
    joints.shoulder = add(joints.shoulder, across, HALF.shoulder)
    joints.hipJ = add(joints.hip, across, HALF.hip)
    joints.hipJ2 = add(joints.hip, across, -HALF.hip)
  } else {
    joints.shoulder2 = joints.shoulder
    joints.hipJ = joints.hip
    joints.hipJ2 = joints.hip
  }

  const angles = { trunk }
  const specs = Object.fromEntries(LIMBS.map((name) => [name, limbSpec(pose, name)]))
  const scaleOf = (name) => fs[name] ?? (name.endsWith('2') ? fs[name.slice(0, -1)] : undefined)
  const base = front ? trunk - 180 : 0
  const sideOf = (name) => (front && name.endsWith('2') ? -1 : 1)
  for (const name of LIMBS) {
    if (!isIk(specs[name])) placeLimb(joints, angles, name, specs[name], scaleOf(name), base, sideOf(name), frame)
  }

  const anchor = typeof pose.anchor === 'string' && joints[pose.anchor] ? pose.anchor : 'hip'
  const at = Array.isArray(pose.at) ? pose.at : [50, 60]
  translate(joints, [at[0] - joints[anchor][0], at[1] - joints[anchor][1]])

  for (const name of LIMBS) {
    if (!isIk(specs[name])) continue
    let spec = specs[name]
    // The left side of a front view reaches for the mirror image of the right side's target.
    if (sideOf(name) < 0 && pose[name] === undefined) {
      const target = targetPoint(spec.to, joints, frame)
      if (target) spec = { ...spec, to: reflect(target, joints.hip, up) }
    }
    placeLimb(joints, angles, name, spec, scaleOf(name), base, sideOf(name), frame)
  }

  // A bent wrist: the fist sits past the wrist, and that's where equipment is held.
  if (Number.isFinite(pose.wrist)) {
    joints.fist = add(joints.hand, dir(pose.wrist), 2.6)
    joints.fist2 = add(joints.hand2, dir(Number.isFinite(pose.wrist2) ? pose.wrist2 : pose.wrist), 2.6)
  }

  return { view: front ? 'front' : 'side', joints, angles, frontDir: front ? null : across, up, trunkScale, headTilt }
}

export const anchorNames = (view) => (view === 'front' ? [...SIDE_ANCHORS, 'shoulder2', 'hipJ', 'hipJ2'] : SIDE_ANCHORS)

// ---- interpolation ---------------------------------------------------------------------------

// Numbers blend, arrays and objects blend member by member, anything else comes from `a`.
export function lerpPose(a, b, t) {
  if (typeof a === 'number' && typeof b === 'number') return lerp(a, b, t)
  if (Array.isArray(a) && Array.isArray(b)) return a.map((value, i) => lerpPose(value, b[i], t))
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const out = {}
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      out[key] = key in a && key in b ? lerpPose(a[key], b[key], t) : key in a ? a[key] : b[key]
    }
    return out
  }
  return a === undefined ? b : a
}

// Same shape (keys, array lengths, value kinds) — what makes two keyframes blendable.
export function sameShape(a, b) {
  if (typeof a === 'number' || typeof b === 'number') return typeof a === 'number' && typeof b === 'number'
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => sameShape(value, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameShape(a[key], b[key]))
  }
  return a === b
}

const easeInOut = (t) => 0.5 - Math.cos(Math.PI * t) / 2

// The order the keyframes are visited in one loop: there and back (A B C B), or round (A B C).
// 'spin' is round too, but its last key repeats the first one turned a full circle (pedals), so
// there's no step back from the last key to the first.
export function stops(count, loop = 'pingpong') {
  const forward = Array.from({ length: count }, (_, i) => i)
  if (loop === 'cycle' || loop === 'spin' || count < 3) return forward
  return [...forward, ...forward.slice(1, -1).reverse()]
}

// The pose at `phase` (0..1) of one loop. Each stop holds briefly, then eases to the next one;
// `smooth` motions (pedalling, running) neither hold nor ease.
export function poseAt(keys, phase, { loop = 'pingpong', smooth = false, hold = 0.14 } = {}) {
  if (!keys.length) return null
  if (keys.length === 1) return keys[0]
  const order = stops(keys.length, loop)
  const slots = loop === 'spin' ? order.length - 1 : order.length
  const p = ((((phase % 1) + 1) % 1) * slots)
  const slot = Math.min(slots - 1, Math.floor(p))
  const local = p - slot
  const from = keys[order[slot]]
  const to = keys[order[(slot + 1) % order.length]]
  if (smooth) return lerpPose(from, to, local)
  const h = clamp(hold, 0, 0.6)
  if (local < h) return from
  return lerpPose(from, to, easeInOut((local - h) / (1 - h)))
}

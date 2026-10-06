// Motion patterns: for each kind of movement, 2-3 keyframe poses (see rig.js for the pose format),
// the equipment drawn around the figure and a few short form cues. A pattern's keys and gear can
// depend on a variant ({ gear, bench, seat, ... }) from the exercise mapping (motion.js).
//
// Conventions used below: the floor is at G; lying face up = head on the left, face down = head on
// the right (the figure always faces "clockwise" from its trunk); standing figures face right.
import { GROUND as G, add, dir } from './rig.js'
import { PLATE_R, barbell, cable, cableColumn, dot, dumbbell, kettlebell, pad, poly, post, ring, seg, trunkPad, trunkPoint } from './scene.js'

const FOOT = G - 1.8 // ankle height with the foot flat on the floor
const PALM = G - 2.3 // a hand resting on the floor
const BENCH = 76.5 // top of a flat bench
const SEAT = 72 // hip height when seated on a bench or machine seat

const stand = (x = 50, extra = {}) => ({ anchor: 'ankle', at: [x, FOOT], trunk: 180, leg: [0, 0, 90], arm: [0, 0], ...extra })
const seated = (x = 44, extra = {}) => ({ at: [x, SEAT], trunk: 182, leg: { to: [x + 17, FOOT], bend: 1, foot: 90 }, arm: [0, 0], ...extra })
const lyingBack = (x = 58, extra = {}) => ({ at: [x, BENCH - 6.6], trunk: -90, leg: { to: [x + 15, FOOT], bend: 1, foot: 90 }, ...extra })
// Arms folded across the chest, turning with the trunk.
const crossed = (trunk) => [trunk - 165, trunk - 40]
// Hands holding a bar across the upper back / at the front of the shoulders / at the chest.
const onBack = { to: { from: 'shoulder', local: [0.8, -6.4] }, bend: 1 }
const frontRack = { to: { from: 'shoulder', local: [0, 7] }, bend: -1 }
// The front rack's forearm points back at the shoulder, so it's drawn short (foreshortened).
const RACK_FS = { arm: [1, 0.55] }
const atChest = { to: { from: 'shoulder', local: [-4, 7.5] }, bend: -1 }

// ---- equipment helpers -----------------------------------------------------------------------

const hand = (j) => j.fist || j.hand
const hand2 = (j) => j.fist2 || j.hand2
// Barbell at the hands; a bar on the back sits on the shoulders, behind the neck.
const barAtHands = ({ j }) => ({ back: barbell(hand(j)) })
const barOnBack = ({ j, skel }) => ({ back: barbell(trunkPoint(skel, 22.6, -5.6)) })
const dumbbells = ({ j }) => ({ far: dumbbell(hand2(j)), front: dumbbell(hand(j)) })
const flatBench = (x0 = 22, x1 = 66) => [pad([x0, BENCH + 2], [x1, BENCH + 2]), post([x0 + 6, BENCH + 4], [x0 + 6, G]), post([x1 - 6, BENCH + 4], [x1 - 6, G])]
const seat = (x, width = 18, y = SEAT + 5.4) => [pad([x - width / 2, y], [x + width / 2, y]), post([x, y + 2], [x, G])]
const backrest = (skel, u0 = -2, u1 = 24) => [trunkPad(skel, u0, u1)]
const box = (x0, x1, top) => poly([[x0, top], [x1, top], [x1, G], [x0, G]], 'pad')
const pullupBar = (c) => [post([c[0] - 8, c[1]], [c[0] + 13, c[1]], 2.4), post([c[0] + 13, c[1]], [c[0] + 13, G], 1.6)]
const lever = (pivot, end, padR = 2.8) => [seg(pivot, end, 2.2, 'gear'), dot(pivot, 1.6, 'gear'), dot(end, padR, 'pad')]
const pick = (v, key, fallback) => (v && v[key] !== undefined ? v[key] : fallback)

function handGear(v, j, skel, j0) {
  const gear = pick(v, 'gear', 'barbell')
  if (gear === 'dumbbell') return dumbbells({ j })
  if (gear === 'kettlebell') return { front: kettlebell(hand(j), dir(skel.angles.arm[1])) }
  if (gear === 'none') return {}
  if (gear === 'smith') return { back: [post([j0.hand[0], 4], [j0.hand[0], G], 1.4), ...barbell(hand(j))] }
  return barAtHands({ j })
}

// ---- the patterns ----------------------------------------------------------------------------

export const PATTERNS = {
  bench_press: {
    label: 'Bench press',
    keys: (v) => {
      const bench = pick(v, 'bench', 'flat')
      if (bench === 'incline') {
        const base = { at: [57, 70], trunk: -128, leg: { to: [74, FOOT], bend: 1, foot: 90 } }
        return [{ ...base, arm: { to: [43, 33], bend: -1 } }, { ...base, arm: { to: [46.5, 50], bend: -1 } }]
      }
      if (bench === 'decline') {
        const base = { at: [60, 63], trunk: -70, leg: [125, 12, 100] }
        return [{ ...base, arm: { to: [40.5, 46], bend: -1 } }, { ...base, arm: { to: [44.5, 63], bend: -1 } }]
      }
      return [lyingBack(58, { arm: { to: [37.6, 45.5], bend: -1 } }), lyingBack(58, { arm: { to: [41, 61.5], bend: -1 } })]
    },
    gear: ({ v, j, skel, j0, skel0 }) => {
      const bench = pick(v, 'bench', 'flat')
      const frame = bench === 'flat'
        ? flatBench()
        : bench === 'incline'
          ? [pad([50, SEAT + 6], [66, SEAT + 6]), ...backrest(skel0, -1, 27), post([58, SEAT + 8], [58, G])]
          : [...backrest(skel0, -3, 28), post([52, 70], [52, G]), dot(add(j0.knee, [3, 4]), 2.6, 'pad')]
      const hands = handGear(v, j, skel, j0)
      return { ...hands, back: [...frame, ...(hands.back || [])] }
    },
    thumb: 1,
    cues: { default: ['Feet flat, shoulder blades squeezed', 'Lower to mid-chest', 'Press up and slightly back'] },
  },

  machine_press: {
    label: 'Machine chest press',
    keys: (v) => {
      const high = pick(v, 'bench', 'flat') === 'incline'
      const base = seated(40, { trunk: 188 })
      return [{ ...base, arm: { to: [50, 49], bend: -1 } }, { ...base, arm: { to: high ? [58, 36] : [62, 48], bend: -1 } }]
    },
    gear: ({ j, skel0 }) => ({ back: [...seat(40), ...backrest(skel0, 2, 26), post([74, 24], [74, G], 2.4)], front: lever([74, 26], hand(j), 1.8) }),
    cues: { default: ['Handles at chest height', 'Press out, don’t lock hard', 'Control the way back'] },
  },

  chest_fly: {
    label: 'Chest fly',
    view: 'front',
    keys: (v) => {
      const gear = pick(v, 'gear', 'dumbbell')
      if (gear === 'cable') {
        const base = { at: [50, 56.7], trunk: 180, leg: [4, 0, 90] }
        return [{ ...base, arm: [118, 125] }, { ...base, arm: [-18, -42] }]
      }
      if (gear === 'machine') {
        const base = { at: [50, 70], trunk: 180, leg: [10, 2, 90], fs: { leg: [0.3, 1] } }
        return [{ ...base, arm: [90, 180], fs: { ...base.fs, arm: [1, 1] } }, { ...base, arm: [90, 180], fs: { ...base.fs, arm: [-0.45, 1] } }]
      }
      // Lying on a bench, seen from above.
      const base = { at: [64, 52], trunk: -90, leg: [8, 4, 90], fs: { leg: [1, 0.35] } }
      return [{ ...base, arm: [90, 104], fs: { ...base.fs, arm: [1, 1] } }, { ...base, arm: [90, 100], fs: { ...base.fs, arm: [-0.2, -0.25] } }]
    },
    gear: ({ v, j }) => {
      const gear = pick(v, 'gear', 'dumbbell')
      if (gear === 'cable') return { back: [...cableColumn(90, 10), ...cableColumn(10, 10)], front: [...cable([88.5, 14], j.hand), ...cable([11.5, 14], j.hand2)] }
      if (gear === 'machine') return { back: [pad([35, 77], [65, 77], 5), pad([50, 76], [50, 40], 9)], front: [dot(j.hand, 2, 'gear'), dot(j.hand2, 2, 'gear')] }
      return { back: [pad([42, 52], [76, 52], 11)], front: [...dumbbell(j.hand), ...dumbbell(j.hand2)] }
    },
    thumb: 1,
    cues: {
      default: ['Slight bend in the elbows', 'Open wide until you feel a stretch', 'Hug the weights back together'],
      cable: ['Step forward, soft elbows', 'Bring hands together low', 'Slow on the way back'],
      machine: ['Elbows at shoulder height', 'Squeeze the pads together', 'Let them open slowly'],
    },
  },

  push_up: {
    label: 'Push-up',
    keys: (v) => {
      if (pick(v, 'style') === 'pike') {
        const base = { anchor: 'toe', at: [20, G - 1], leg: [-30, -30, 25] }
        return [{ ...base, trunk: 68, arm: { to: [57, PALM], bend: -1 } }, { ...base, trunk: 44, arm: { to: [57, PALM], bend: -1 } }]
      }
      const base = { anchor: 'toe', at: [19, G - 1] }
      return [
        { ...base, trunk: 111, leg: [-69, -69, 20], arm: { to: [69, PALM], bend: -1 } },
        { ...base, trunk: 97, leg: [-83, -83, 8], arm: { to: [69, PALM], bend: -1 } },
      ]
    },
    gear: () => ({}),
    thumb: 1,
    cues: {
      default: ['Hands under shoulders', 'Body in one straight line', 'Chest to the floor, push away'],
      pike: ['Hips high, an upside-down V', 'Lower the head between the hands', 'Press back up'],
    },
  },

  dip: {
    label: 'Dip',
    keys: (v) => {
      if (pick(v, 'style') === 'bench') {
        const legs = { to: [64, FOOT - 1], bend: 1, foot: 150 }
        return [
          { anchor: 'hand', at: [35, BENCH - 2], trunk: 180, arm: [-15, -10], leg: legs },
          { anchor: 'hand', at: [35, BENCH - 2], trunk: 178, arm: [-100, 15], leg: legs },
        ]
      }
      const legs = [-4, -55, 25]
      return [
        { anchor: 'hand', at: [50, 52], trunk: 172, arm: [0, 0], leg: legs },
        { anchor: 'hand', at: [50, 52], trunk: 150, arm: [-80, 15], leg: [12, -40, 25] },
      ]
    },
    gear: ({ v, j, j0, skel }) => {
      if (pick(v, 'style') === 'bench') return { back: flatBench(6, 36) }
      const bars = [post([j0.hand[0] - 5, j0.hand[1] + 1], [j0.hand[0] + 6, j0.hand[1] + 1], 2.2), post([j0.hand[0] + 6, j0.hand[1] + 1], [j0.hand[0] + 6, G])]
      const extra = []
      if (pick(v, 'assist') === 'machine') extra.push(...lever([j.knee[0] - 16, j.knee[1] + 8], add(j.knee, [0, 3.5]), 3))
      if (pick(v, 'belt')) extra.push(seg(j.hip, add(j.hip, [2, 10]), 0.9, 'thin'), ...barbell(add(j.hip, [2, 14]), 4.2))
      return { back: bars, front: extra }
    },
    thumb: 1,
    cues: {
      default: ['Lean forward a little', 'Lower until elbows are at 90°', 'Press back to straight arms'],
      bench: ['Hands on the bench behind you', 'Bend the elbows straight back', 'Push up through the palms'],
    },
  },

  pullover: {
    label: 'Pullover',
    keys: () => [lyingBack(58, { arm: [178, 182] }), lyingBack(58, { arm: [272, 280] })],
    gear: ({ j }) => ({ back: flatBench(), front: dumbbell(j.hand) }),
    cues: { default: ['Hold one dumbbell over your chest', 'Lower it back behind your head', 'Pull it back over the chest'] },
  },

  hinge: {
    label: 'Hip hinge',
    keys: (v) => {
      const style = pick(v, 'style', 'deadlift')
      const top = stand(48, { arm: { to: [49.5, 61], bend: -1 } })
      if (style === 'good_morning') return [stand(48, { arm: onBack }), { ...stand(48), trunk: 104, leg: [14, -6, 90], arm: onBack }]
      if (style === 'rdl') return [top, { ...stand(48), trunk: 110, leg: [28, 0, 90], arm: { to: [53, 75], bend: -1 } }]
      if (style === 'single_leg') {
        return [
          { ...stand(48), leg: [0, 0, 90], leg2: [4, -20, 70], arm: [0, 0] },
          { ...stand(48), trunk: 100, leg: [22, 2, 90], leg2: [-78, -82, 5], arm: [6, 6] },
        ]
      }
      const deep = style === 'trap' || style === 'sumo'
      return [{ ...stand(48), trunk: deep ? 128 : 120, leg: deep ? [70, -16, 90] : [75, -15, 90], arm: { to: [51, G - PLATE_R], bend: -1 } }, top]
    },
    gear: ({ v, j, skel, j0 }) => {
      const style = pick(v, 'style', 'deadlift')
      if (style === 'good_morning') return barOnBack({ j, skel })
      return handGear(v, j, skel, j0)
    },
    thumb: 0,
    thumbFor: { rdl: 1, good_morning: 1, single_leg: 1 },
    cues: {
      default: ['Bar over mid-foot, back flat', 'Push the floor away', 'Stand tall, squeeze the glutes'],
      rdl: ['Soft knees, push the hips back', 'Slide the weight down the legs', 'Stop at the stretch, drive the hips forward'],
      good_morning: ['Bar on the upper back', 'Hips back, chest down, back flat', 'Stand up with the hips'],
      single_leg: ['Stand on one leg, soft knee', 'Tip forward, back leg straight behind', 'Return to standing tall'],
      sumo: ['Wide stance, toes out', 'Hands inside the knees', 'Push the knees out as you stand'],
      trap: ['Stand inside the bar', 'Hips down, chest up', 'Drive up through the whole foot'],
    },
  },

  row_bent: {
    label: 'Bent-over row',
    keys: () => {
      const base = { ...stand(52), trunk: 120, leg: [35, -10, 90] }
      return [{ ...base, arm: [-4, -4] }, { ...base, arm: [-100, 0] }]
    },
    gear: ({ v, j }) => {
      if (pick(v, 'gear') === 'landmine') {
        const end = add(j.hand, [8, 1.5])
        return { back: [seg([16, G - 1], end, 1.6, 'gear'), ...barbell(add(end, [0, 0]), 6.4)] }
      }
      return barAtHands({ j })
    },
    thumb: 1,
    cues: { default: ['Hinge forward, back flat', 'Pull to the belly', 'Elbows go back, not out'] },
  },

  row_one_arm: {
    label: 'One-arm row',
    keys: () => {
      const base = { at: [44, 57], trunk: 98, leg: { to: [52, FOOT], bend: 1, foot: 90 }, leg2: [7, -90, -88], arm2: { to: [66, BENCH - 2.5], bend: -1 } }
      return [{ ...base, arm: [0, 0] }, { ...base, arm: [-112, 2] }]
    },
    gear: ({ j }) => ({ back: flatBench(26, 74), front: dumbbell(j.hand) }),
    thumb: 1,
    cues: { default: ['Knee and hand on the bench', 'Pull the dumbbell to your hip', 'Lower until the arm is long'] },
  },

  row_supported: {
    label: 'Chest-supported row',
    keys: () => {
      const base = { at: [44, 63], trunk: 125, leg: { to: [28, FOOT], bend: 1, foot: 80 } }
      return [{ ...base, arm: [0, 0] }, { ...base, arm: [-116, 0] }]
    },
    gear: ({ j, skel0 }) => ({ back: [trunkPad(skel0, -3, 22, 1), post(trunkPoint(skel0, 4, 7), [52, G])], ...dumbbells({ j }) }),
    thumb: 1,
    cues: { default: ['Chest on the incline pad', 'Row both elbows back', 'Squeeze the shoulder blades'] },
  },

  row_seated: {
    label: 'Seated row',
    keys: (v) => {
      if (pick(v, 'gear') === 'machine') {
        const base = seated(40, { trunk: 182 })
        return [{ ...base, arm: { to: [64, 50], bend: -1 } }, { ...base, arm: { to: [47, 53], bend: -1 } }]
      }
      const legs = { to: [64, 80], bend: 1, foot: 160 }
      return [
        { at: [36, 74], trunk: 158, leg: legs, arm: { to: [64, 64], bend: -1 } },
        { at: [36, 74], trunk: 186, leg: legs, arm: { to: [45, 66], bend: -1 } },
      ]
    },
    gear: ({ v, j }) => {
      if (pick(v, 'gear') === 'machine') return { back: [...seat(40), pad([56, 42], [56, 60], 4.4), post([56, 60], [56, G])], front: lever([70, 70], hand(j), 1.8) }
      return { back: [...seat(36, 20, 79), pad([68, 76], [68, 86], 3), ...cableColumn(88, 30)], front: cable([86.5, 66], hand(j)) }
    },
    thumb: 1,
    cues: { default: ['Sit tall, chest up', 'Pull the handle to your belly', 'Let the arms reach forward slowly'] },
  },

  inverted_row: {
    label: 'Inverted row',
    keys: () => [
      { anchor: 'heel', at: [86, G - 1.6], trunk: -102, leg: [78, 78, 168], arm: { to: [42, 50], bend: -1 } },
      { anchor: 'heel', at: [86, G - 1.6], trunk: -118, leg: [62, 62, 152], arm: { to: [42, 50], bend: -1 } },
    ],
    gear: () => ({ back: [post([35, 50], [49, 50], 2.4), post([35, 50], [35, G], 1.6)] }),
    thumb: 1,
    cues: { default: ['Hang under a bar, heels down', 'Body straight like a plank', 'Pull your chest to the bar'] },
  },

  pulldown: {
    label: 'Lat pulldown',
    keys: () => {
      const base = { at: [46, SEAT], trunk: 190, leg: { to: [62, FOOT], bend: 1, foot: 90 } }
      return [{ ...base, arm: { to: [47, 25], bend: -1 } }, { ...base, arm: { to: [50, 49], bend: -1 } }]
    },
    gear: ({ v, j, j0 }) => {
      const frame = [...seat(46), dot(add(j0.knee, [-1, -5]), 3, 'pad'), post(add(j0.knee, [-1, -5]), [j0.knee[0] - 1, G], 1.4)]
      if (pick(v, 'gear') === 'machine') return { back: frame, front: [...lever([72, 14], j.hand, 1.8)] }
      return { back: [...frame, ...cableColumn(66, 4)], front: [seg([j.hand[0] - 7, j.hand[1]], [j.hand[0] + 7, j.hand[1]], 1.6, 'gear'), ...cable([j.hand[0] + 1, 6], j.hand)] }
    },
    thumb: 1,
    cues: { default: ['Thighs under the pad', 'Pull the bar to your upper chest', 'Elbows down and back'] },
  },

  straight_arm_pulldown: {
    label: 'Straight-arm pulldown',
    keys: () => {
      const base = { ...stand(46), trunk: 162, leg: [10, -4, 90] }
      return [{ ...base, arm: [148, 152] }, { ...base, arm: [12, 16] }]
    },
    gear: ({ j }) => ({ back: cableColumn(84, 6), front: cable([82.5, 12], j.hand) }),
    thumb: 1,
    cues: { default: ['Arms long, slight bend', 'Sweep the bar down to your thighs', 'Feel it in the lats'] },
  },

  pull_up: {
    label: 'Pull-up',
    keys: (v) => {
      const legs = pick(v, 'assist') === 'machine' ? [2, -88, -80] : [6, -32, 30]
      return [
        { anchor: 'hand', at: [50, 10], trunk: 182, arm: [180, 180], leg: legs },
        { anchor: 'hand', at: [50, 10], trunk: 190, arm: [22, 175], leg: legs },
      ]
    },
    gear: ({ v, j }) => {
      const out = { back: pullupBar([50, 10]), front: [] }
      if (pick(v, 'belt')) out.front.push(seg(j.hip, add(j.hip, [1, 9]), 0.9, 'thin'), ...barbell(add(j.hip, [1, 13]), 4.2))
      if (pick(v, 'assist') === 'machine') out.front.push(...lever([j.knee[0] - 16, j.knee[1] + 16], add(j.knee, [0, 3.4]), 3.2))
      if (pick(v, 'assist') === 'band') out.front.push(seg([50, 10], j.knee, 1.2, 'thin'), seg([51.5, 10], add(j.knee, [1, 1]), 1.2, 'thin'))
      return out
    },
    thumb: 1,
    cues: {
      default: ['Hang with straight arms', 'Pull your chest up to the bar', 'Lower all the way down'],
      chin: ['Palms facing you', 'Chin over the bar', 'Lower all the way down'],
    },
  },

  dead_hang: {
    label: 'Hang',
    hold: true,
    keys: () => [
      { anchor: 'hand', at: [50, 10], trunk: 180, arm: [180, 180], leg: [2, -4, 50] },
      { anchor: 'hand', at: [50, 10], trunk: 181, arm: [181, 180], leg: [3, -6, 48] },
    ],
    gear: () => ({ back: pullupBar([50, 10]) }),
    cues: { default: ['Grip the bar, arms straight', 'Relax the shoulders, breathe', 'Hold for time'] },
  },

  back_extension: {
    label: 'Back extension',
    keys: () => [
      { at: [44, 57], trunk: 30, leg: [-45, -45, 30], arm: crossed(30) },
      { at: [44, 57], trunk: 135, leg: [-45, -45, 30], arm: crossed(135) },
    ],
    gear: ({ j0, skel0 }) => ({ back: [dot(trunkPoint(skel0, -2, 7.5), 3.6, 'pad'), dot(add(j0.ankle, [2, 3.6]), 2.4, 'pad'), post(add(j0.ankle, [2, 4]), trunkPoint(skel0, -2, 7.5), 2), post(trunkPoint(skel0, -2, 9), [58, G], 1.8)] }),
    thumb: 1,
    cues: { default: ['Hips on the pad, feet locked in', 'Lower with a long, flat back', 'Rise until the body is straight'] },
  },

  face_pull: {
    label: 'Face pull',
    keys: () => [
      { ...stand(48), trunk: 184, arm: [90, 90], fs: { arm: [1, 1] } },
      { ...stand(48), trunk: 186, arm: [92, 172], fs: { arm: [-0.35, 1] } },
    ],
    gear: ({ j }) => ({ back: cableColumn(90, 18), front: cable([88.5, 31], j.hand) }),
    thumb: 1,
    cues: { default: ['Rope at face height', 'Pull toward your eyes, elbows high', 'Finish with the hands by your ears'] },
  },

  pull_apart: {
    label: 'Band pull-apart',
    view: 'front',
    keys: () => {
      const base = { at: [50, 56.7], trunk: 180, leg: [4, 0, 90] }
      return [{ ...base, arm: [90, 90], fs: { arm: [-0.25, -0.3] } }, { ...base, arm: [90, 90], fs: { arm: [1, 1] } }]
    },
    gear: ({ j }) => ({ front: [seg(j.hand, j.hand2, 1.3, 'thin')] }),
    thumb: 1,
    cues: { default: ['Arms straight out in front', 'Pull the band apart to your chest', 'Squeeze the shoulder blades'] },
  },

  shrug: {
    label: 'Shrug',
    view: 'front',
    keys: () => {
      const base = { at: [50, 56.7], trunk: 180, leg: [3, 0, 90], arm: [4, 2] }
      return [{ ...base, lift: 0 }, { ...base, lift: 3.6 }]
    },
    gear: ({ v, j }) => (pick(v, 'gear') === 'dumbbell'
      ? { front: [...dumbbell(j.hand), ...dumbbell(j.hand2)] }
      : { front: [seg(add(j.hand, [6, 0]), add(j.hand2, [-6, 0]), 1.8, 'gear'), ...barbell(add(j.hand, [8, 0]), 3.4), ...barbell(add(j.hand2, [-8, 0]), 3.4)] }),
    thumb: 1,
    cues: { default: ['Arms long, weight at your sides', 'Shoulders straight up to the ears', 'Pause, then lower slowly'] },
  },

  upright_row: {
    label: 'Upright row',
    view: 'front',
    keys: () => {
      const base = { at: [50, 56.7], trunk: 180, leg: [3, 0, 90] }
      return [{ ...base, arm: [-3, -8] }, { ...base, arm: [112, -58] }]
    },
    gear: ({ j }) => ({ front: [seg(add(j.hand, [5, 0]), add(j.hand2, [-5, 0]), 1.8, 'gear'), ...barbell(add(j.hand, [7, 0]), 3.4), ...barbell(add(j.hand2, [-7, 0]), 3.4)] }),
    thumb: 1,
    cues: { default: ['Hands close on the bar', 'Pull up to the chest, elbows high', 'Lower with control'] },
  },

  carry: {
    label: 'Carry',
    smooth: true,
    keys: () => [
      { at: [50, 56.7], trunk: 180, leg: [18, 4, 90], leg2: [-16, -30, 70], arm: [2, 2] },
      { at: [50, 56.7], trunk: 180, leg: [-16, -30, 70], leg2: [18, 4, 90], arm: [2, 2] },
    ],
    gear: ({ j }) => dumbbells({ j }),
    cues: { default: ['Heavy weights at your sides', 'Stand tall, short quick steps', 'Walk for distance or time'] },
  },

  overhead_press: {
    label: 'Overhead press',
    keys: (v) => {
      const gear = pick(v, 'gear', 'barbell')
      if (gear === 'landmine') {
        const base = { ...stand(46), trunk: 172, leg: [10, -4, 90], leg2: [-14, -18, 80] }
        return [{ ...base, arm: { to: [56, 38], bend: -1 } }, { ...base, arm: { to: [69, 19], bend: -1 } }]
      }
      const sit = pick(v, 'seat')
      const base = sit ? seated(44, { trunk: 184 }) : stand(50)
      if (gear !== 'barbell') {
        // Dumbbells or handles start beside the head: elbows out to the sides (short upper arm in
        // this view), forearms upright. Arnold starts with the elbows in front.
        const start = pick(v, 'arnold') ? [62, 176] : [100, 182]
        const startFs = pick(v, 'arnold') ? [0.9, 1] : [0.4, 1]
        return [{ ...base, arm: start, fs: { arm: startFs } }, { ...base, arm: [182, 182], fs: { arm: [1, 1] } }]
      }
      const start = { from: 'shoulder', local: [0.5, 4.4] }
      const keys = [{ ...base, arm: { to: start, bend: -1 } }, { ...base, arm: { to: { from: 'shoulder', local: [24.3, 1.5] }, bend: -1 } }]
      if (pick(v, 'dip')) return [keys[0], { ...base, leg: [30, -24, 90], arm: { to: start, bend: -1 } }, keys[1]]
      return keys
    },
    loopFor: { dip: 'cycle' },
    gear: ({ v, j, skel, j0, skel0 }) => {
      const gear = pick(v, 'gear', 'barbell')
      const sit = pick(v, 'seat')
      const frame = sit ? [...seat(44), ...backrest(skel0, 0, 26)] : []
      if (gear === 'landmine') return { back: [seg([12, G - 1], add(hand(j), [5, -6]), 1.6, 'gear'), ...barbell(add(hand(j), [5, -6]), 5.6)] }
      if (gear === 'machine') return { back: [...lever([30, 62], hand(j), 1.8), ...frame] }
      const hands = handGear(v, j, skel, j0)
      return { ...hands, back: [...frame, ...(hands.back || [])] }
    },
    thumb: 1,
    thumbFor: { dip: 2 },
    cues: {
      default: ['Brace your core, squeeze the glutes', 'Press straight overhead', 'Head through at the top'],
      seat: ['Back against the pad', 'Press up until arms are straight', 'Lower to ear height'],
      dip: ['Dip the knees a little', 'Drive up with the legs', 'Finish the press overhead'],
      landmine: ['Bar end at your shoulder', 'Press up and forward', 'Lower to the shoulder'],
    },
  },

  lateral_raise: {
    label: 'Lateral raise',
    view: 'front',
    keys: (v) => {
      const gear = pick(v, 'gear', 'dumbbell')
      if (gear === 'machine') {
        const fs = { leg: [0.3, 1], arm: [1, 0.35] }
        const base = { at: [50, 70], trunk: 180, leg: [10, 2, 90], fs }
        return [{ ...base, arm: [12, 12] }, { ...base, arm: [86, 86] }]
      }
      const base = { at: [50, 56.7], trunk: 180, leg: [4, 0, 90] }
      if (gear === 'cable') return [{ ...base, arm: [-8, -4], arm2: [12, 50] }, { ...base, arm: [84, 88], arm2: [12, 50] }]
      return [{ ...base, arm: [10, 8] }, { ...base, arm: [84, 88] }]
    },
    gear: ({ v, j }) => {
      const gear = pick(v, 'gear', 'dumbbell')
      if (gear === 'cable') return { back: cableColumn(12, 60), front: cable([13.5, 86], j.hand) }
      if (gear === 'machine') return { back: [pad([35, 77], [65, 77], 5), pad([50, 76], [50, 42], 9)], front: [dot(j.elbow, 2.6, 'pad'), dot(j.elbow2, 2.6, 'pad')] }
      return { front: [...dumbbell(j.hand), ...dumbbell(j.hand2)] }
    },
    thumb: 1,
    cues: { default: ['Slight bend in the elbows', 'Raise out to the sides to shoulder height', 'Lower slowly'] },
  },

  front_raise: {
    label: 'Front raise',
    keys: () => [stand(48, { arm: [6, 6] }), stand(48, { arm: [92, 94] })],
    gear: ({ j }) => dumbbells({ j }),
    thumb: 1,
    cues: { default: ['Weights in front of the thighs', 'Raise straight in front to eye level', 'Lower with control'] },
  },

  rear_delt_fly: {
    label: 'Rear delt fly',
    view: 'front',
    keys: (v) => {
      const gear = pick(v, 'gear', 'dumbbell')
      if (gear === 'dumbbell') {
        // Bent over, seen from the front: a short trunk with the head dropped in front of it.
        const base = { at: [50, 64], trunk: 180, head: 180, leg: [6, -6, 90], fs: { trunk: 0.5, leg: [0.85, 1] } }
        return [{ ...base, arm: [4, 2] }, { ...base, arm: [84, 80] }]
      }
      const sit = gear === 'machine'
      const base = sit ? { at: [50, 70], trunk: 180, leg: [10, 2, 90], fs: { leg: [0.3, 1] } } : { at: [50, 56.7], trunk: 180, leg: [4, 0, 90] }
      return [{ ...base, arm: [90, 90], fs: { ...base.fs, arm: [-0.3, -0.3] } }, { ...base, arm: [90, 90], fs: { ...base.fs, arm: [1, 1] } }]
    },
    gear: ({ v, j }) => {
      const gear = pick(v, 'gear', 'dumbbell')
      if (gear === 'cable') return { back: [...cableColumn(92, 30), ...cableColumn(8, 30)], front: [...cable([90.5, 35], j.hand2), ...cable([9.5, 35], j.hand)] }
      if (gear === 'machine') return { back: [pad([35, 77], [65, 77], 5)], front: [dot(j.hand, 2, 'gear'), dot(j.hand2, 2, 'gear')] }
      return { front: [...dumbbell(j.hand), ...dumbbell(j.hand2)] }
    },
    thumb: 1,
    cues: {
      default: ['Bend forward, back flat', 'Raise the arms out wide', 'Squeeze the back of the shoulders'],
      cable: ['Cables crossed in front', 'Pull the arms open wide', 'Squeeze the back of the shoulders'],
      machine: ['Chest against the pad', 'Sweep the arms open wide', 'Return slowly'],
    },
  },

  curl: {
    label: 'Curl',
    keys: (v) => {
      const style = pick(v, 'style', 'standing')
      if (style === 'incline') {
        const base = { ...seated(48), trunk: 214 }
        return [{ ...base, arm: [-2, 2] }, { ...base, arm: [-2, 136] }]
      }
      if (style === 'preacher') {
        const base = seated(40, { trunk: 176 })
        return [{ ...base, arm: [48, 52] }, { ...base, arm: [48, 168] }]
      }
      if (style === 'concentration') {
        const base = seated(42, { trunk: 142, leg: { to: [62, FOOT], bend: 1, foot: 90 } })
        return [{ ...base, arm: [6, 8] }, { ...base, arm: [6, 140] }]
      }
      return [stand(50, { arm: [2, 6] }), stand(50, { arm: [2, 148] })]
    },
    gear: ({ v, j, skel, j0, skel0 }) => {
      const style = pick(v, 'style', 'standing')
      const gear = pick(v, 'gear', 'barbell')
      const frame = style === 'incline' ? [...seat(48), ...backrest(skel0, -1, 27)]
        : style === 'preacher' ? [...seat(40), pad(add(j0.shoulder, dir(48), 4), add(add(j0.elbow, dir(-42), 3.4), dir(48), 1), 4.2), post([54, 64], [54, G])]
          : style === 'concentration' ? seat(42) : []
      if (gear === 'cable') return { back: [...frame, ...cableColumn(80, 70)], front: cable([78.5, 86], hand(j)) }
      const hands = gear === 'dumbbell' ? (style === 'concentration' ? { front: dumbbell(hand(j)) } : dumbbells({ j })) : barAtHands({ j })
      return { ...hands, back: [...frame, ...(hands.back || [])] }
    },
    thumb: 1,
    cues: {
      default: ['Elbows pinned at your sides', 'Curl the weight to your shoulders', 'Lower all the way down'],
      hammer: ['Palms facing each other', 'Curl up, elbows still', 'Lower all the way down'],
      incline: ['Lie back, arms hanging', 'Curl without moving the elbows', 'Lower to a full stretch'],
      preacher: ['Upper arms flat on the pad', 'Curl up, don’t lift the elbows', 'Lower slowly to almost straight'],
      concentration: ['Elbow against the inner thigh', 'Curl to the shoulder', 'Lower slowly'],
      reverse: ['Palms facing down', 'Curl up, wrists straight', 'Lower with control'],
    },
  },

  wrist_curl: {
    label: 'Wrist curl',
    keys: () => {
      const base = seated(40, { trunk: 150, arm: [-3, 90] })
      return [{ ...base, wrist: 10 }, { ...base, wrist: 150 }]
    },
    gear: ({ j }) => ({ back: seat(40), front: dumbbell(hand(j), true) }),
    thumb: 1,
    cues: { default: ['Forearms on your thighs', 'Let the wrists bend down', 'Curl the weight up with the wrists'] },
  },

  pushdown: {
    label: 'Pushdown',
    keys: (v) => {
      if (pick(v, 'seat')) {
        const base = seated(44, { trunk: 182 })
        return [{ ...base, arm: [28, 160] }, { ...base, arm: [28, 34] }]
      }
      const base = { ...stand(48), trunk: 172 }
      return [{ ...base, arm: [6, 150] }, { ...base, arm: [6, 6] }]
    },
    gear: ({ v, j, j0, skel0 }) => {
      if (pick(v, 'seat')) return { back: [...seat(44), ...backrest(skel0, 0, 26), pad(add(j0.shoulder, dir(28), 4), add(j0.elbow, dir(-62), 3.2), 4)], front: lever(j0.elbow, hand(j), 1.8) }
      return { back: cableColumn(62, 4), front: cable([j0.hand[0] + 4, 8], hand(j)) }
    },
    thumb: 1,
    cues: { default: ['Elbows tucked at your sides', 'Push down until arms are straight', 'Only the forearms move'] },
  },

  overhead_extension: {
    label: 'Overhead extension',
    keys: (v) => {
      if (pick(v, 'gear') === 'cable') {
        const base = { ...stand(52), trunk: 160, leg: [14, -6, 90], leg2: [-14, -18, 80] }
        return [{ ...base, arm: [150, -40] }, { ...base, arm: [150, -200] }]
      }
      const base = seated(46, { trunk: 182 })
      return [{ ...base, arm: [176, -22] }, { ...base, arm: [176, -180] }]
    },
    gear: ({ v, j, skel0 }) => {
      if (pick(v, 'gear') === 'cable') return { back: cableColumn(20, 60), front: cable([21.5, 84], hand(j)) }
      return { back: [...seat(46), ...backrest(skel0, -1, 18)], front: dumbbell(hand(j)) }
    },
    thumb: 1,
    cues: { default: ['Elbows point up, close to your head', 'Lower the weight behind your head', 'Straighten the arms overhead'] },
  },

  skull_crusher: {
    label: 'Skull crusher',
    keys: () => [lyingBack(58, { arm: [188, 186] }), lyingBack(58, { arm: [188, 304] })],
    gear: ({ j }) => ({ back: [...flatBench(), ...barbell(hand(j))] }),
    thumb: 1,
    cues: { default: ['Arms straight up over the chest', 'Bend the elbows to bring the bar to your forehead', 'Extend back up'] },
  },

  kickback: {
    label: 'Kickback',
    keys: () => {
      const base = { at: [44, 57], trunk: 104, leg: { to: [52, FOOT], bend: 1, foot: 90 }, leg2: [7, -90, -88], arm2: { to: [66, BENCH - 2.5], bend: -1 } }
      return [{ ...base, arm: [-95, 0] }, { ...base, arm: [-95, -92] }]
    },
    gear: ({ j }) => ({ back: flatBench(26, 74), front: dumbbell(j.hand) }),
    thumb: 1,
    cues: { default: ['Upper arm level with your back', 'Straighten the arm behind you', 'Keep the elbow still'] },
  },

  squat: {
    label: 'Squat',
    keys: (v) => {
      const hold = pick(v, 'hold', 'back')
      if (hold === 'hack') {
        return [
          { anchor: 'ankle', at: [64, 84], trunk: 208, leg: [28, 28, 120], arm: onBack },
          { anchor: 'ankle', at: [64, 84], trunk: 196, leg: [118, -12, 120], arm: onBack },
        ]
      }
      const arms = hold === 'front' ? frontRack : hold === 'goblet' ? atChest : hold === 'none' ? [5, 5] : onBack
      const armsDown = hold === 'none' ? [88, 90] : arms
      const lean = hold === 'front' || hold === 'goblet' ? 152 : 140
      const fs = hold === 'front' ? RACK_FS : { arm: [1, 1] }
      return [stand(50, { arm: arms, fs }), { ...stand(50), trunk: lean, leg: [86, -28, 90], arm: armsDown, fs }]
    },
    gear: ({ v, j, skel, j0, skel0 }) => {
      const hold = pick(v, 'hold', 'back')
      if (hold === 'hack') return { back: [trunkPad(skel, -3, 25), seg([20, 26], [64, G - 6], 2, 'frame'), pad(add(j0.heel, [-2, 3]), add(j0.toe, [3, 3]), 2.6)] }
      if (hold === 'goblet') return { front: dumbbell(hand(j)) }
      if (hold === 'none') return {}
      const bar = hold === 'front' ? barbell(trunkPoint(skel, 22, 5.4)) : barbell(trunkPoint(skel, 22.6, -5.6))
      if (hold === 'smith') return { back: [post([trunkPoint(skel0, 22.6, -5.6)[0], 4], [trunkPoint(skel0, 22.6, -5.6)[0], G], 1.4), ...bar] }
      return { back: bar }
    },
    thumb: 1,
    cues: {
      default: ['Feet shoulder-width', 'Sit back and down', 'Knees track over toes'],
      front: ['Bar on the front of the shoulders, elbows high', 'Sit straight down, chest up', 'Drive up through the whole foot'],
      goblet: ['Hold the weight at your chest', 'Sit down between the knees', 'Stand up tall'],
      hack: ['Back flat against the pad', 'Lower until thighs are level', 'Push the platform away'],
    },
  },

  leg_press: {
    label: 'Leg press',
    keys: () => {
      const base = { at: [34, 72], trunk: 238 }
      return [{ ...base, leg: { to: [68, 41], bend: 1, foot: 218 } }, { ...base, leg: { to: [56, 52], bend: 1, foot: 218 } }]
    },
    gear: ({ j, skel0 }) => {
      const sole = (p) => add(p, dir(125), -2.4)
      return { back: [...backrest(skel0, -2, 25), pad([26, 79], [40, 79]), post([33, 80], [33, G]), seg([50, 62], [88, 27], 2, 'frame')], front: [pad(sole(add(j.heel, dir(215), -1.5)), sole(add(j.toe, dir(215), 2)), 2.8)] }
    },
    thumb: 1,
    cues: { default: ['Feet flat on the platform', 'Lower until knees reach about 90°', 'Push away without locking the knees'] },
  },

  lunge: {
    label: 'Lunge',
    keys: (v) => {
      const style = pick(v, 'style', 'walking')
      const arms = pick(v, 'gear') === 'barbell' ? onBack : [2, 2]
      if (style === 'bulgarian') {
        const back = { to: [31, 70], bend: 1, foot: -70 }
        return [
          { anchor: 'ankle', at: [62, FOOT], trunk: 178, leg: [24, -8, 90], leg2: back, arm: arms },
          { anchor: 'ankle', at: [62, FOOT], trunk: 168, leg: [82, -12, 90], leg2: back, arm: arms },
        ]
      }
      const back = { to: [37, G - 6.2], bend: 1, foot: 30 }
      return [
        { anchor: 'ankle', at: [62, FOOT], trunk: 180, leg: [25, -10, 90], leg2: back, arm: arms },
        { anchor: 'ankle', at: [62, FOOT], trunk: 178, leg: [88, -5, 90], leg2: back, arm: arms },
      ]
    },
    gear: ({ v, j, skel }) => {
      const out = pick(v, 'gear') === 'barbell' ? { back: barbell(trunkPoint(skel, 22.6, -5.6)) } : dumbbells({ j })
      if (pick(v, 'style') === 'bulgarian') out.back = [...(out.back || []), ...flatBench(8, 33)]
      return out
    },
    thumb: 1,
    cues: {
      default: ['Long step, torso upright', 'Drop the back knee toward the floor', 'Push through the front heel'],
      bulgarian: ['Back foot on the bench', 'Lower straight down', 'Drive up through the front foot'],
      reverse: ['Step back into the lunge', 'Back knee toward the floor', 'Push back to standing'],
    },
  },

  step_up: {
    label: 'Step-up',
    keys: () => [
      { anchor: 'ankle', at: [62, 74 - 1.8], trunk: 172, leg: [85, -25, 90], leg2: { to: [46, 87], bend: 1, foot: 40 }, arm: [2, 2] },
      { anchor: 'ankle', at: [62, 74 - 1.8], trunk: 180, leg: [0, 0, 90], leg2: { to: [60, 62], bend: 1, foot: 70 }, arm: [2, 2] },
    ],
    gear: ({ j }) => ({ back: [box(54, 76, 74)], ...dumbbells({ j }) }),
    thumb: 1,
    cues: { default: ['Whole foot on the box', 'Drive up through that heel', 'Step down with control'] },
  },

  leg_extension: {
    label: 'Leg extension',
    keys: () => {
      const base = { at: [40, 70], trunk: 186, arm: [10, 30] }
      return [{ ...base, leg: [90, -8, 82] }, { ...base, leg: [90, 86, 176] }]
    },
    gear: ({ j, skel0, j0 }) => ({ back: [...seat(42, 20, 75.4), ...backrest(skel0, 0, 25)], front: lever(j0.knee, add(j.ankle, dir(skel0.angles.leg[1] + 0), 0), 2.6) }),
    thumb: 1,
    cues: { default: ['Knees in line with the machine pivot', 'Straighten the legs fully', 'Lower slowly'] },
  },

  leg_curl: {
    label: 'Leg curl',
    keys: (v) => {
      if (pick(v, 'style') === 'seated') {
        const base = { at: [40, 70], trunk: 186, arm: [10, 30] }
        return [{ ...base, leg: [90, 88, 170] }, { ...base, leg: [90, -20, 80] }]
      }
      const base = { at: [50, BENCH - 6.2], trunk: 93, arm: { to: [80, 82], bend: -1 } }
      return [{ ...base, leg: [-87, -88, -10] }, { ...base, leg: [-87, -200, -120] }]
    },
    gear: ({ v, j }) => {
      const pad2 = dot(add(j.ankle, dir(pick(v, 'style') === 'seated' ? 180 : 0), 3), 2.6, 'pad')
      if (pick(v, 'style') === 'seated') return { back: [...seat(42, 20, 75.4), pad([30, 64], [26, 44], 4)], front: [pad2, dot(add(j.knee, [-4, -5]), 2.8, 'pad')] }
      return { back: flatBench(18, 80), front: [pad2] }
    },
    thumb: 1,
    cues: { default: ['Pad just above the heels', 'Curl the heels toward you', 'Lower slowly, don’t drop it'] },
  },

  nordic: {
    label: 'Nordic curl',
    keys: () => [
      { anchor: 'knee', at: [40, G - 3.4], trunk: 180, leg: [0, -90, -100], arm: [70, 150] },
      { anchor: 'knee', at: [40, G - 3.4], trunk: 118, leg: [-62, -90, -100], arm: [70, 110] },
    ],
    gear: ({ j0 }) => ({ back: [pad([10, G - 1], [44, G - 1], 2.4)], front: [dot(add(j0.ankle, [0, -4]), 2.4, 'pad')] }),
    thumb: 1,
    cues: { default: ['Kneel with the ankles held down', 'Lean forward slowly, hips straight', 'Pull back up with the hamstrings'] },
  },

  hip_thrust: {
    label: 'Hip thrust',
    keys: (v) => {
      if (pick(v, 'style') === 'floor') {
        return [
          { anchor: 'shoulder', at: [30, G - 5], trunk: -88, head: 0, leg: { to: [64, FOOT], bend: 1, foot: 90 }, arm: [-95, -95] },
          { anchor: 'shoulder', at: [30, G - 5], trunk: -58, head: -30, leg: { to: [64, FOOT], bend: 1, foot: 90 }, arm: [-95, -95] },
        ]
      }
      return [
        { anchor: 'shoulder', at: [34, 72], trunk: -128, leg: { to: [70, FOOT], bend: 1, foot: 90 }, arm: [20, 110] },
        { anchor: 'shoulder', at: [34, 72], trunk: -90, leg: { to: [70, FOOT], bend: 1, foot: 90 }, arm: [20, 110] },
      ]
    },
    gear: ({ v, j, skel }) => {
      if (pick(v, 'style') === 'floor') return {}
      return { back: flatBench(6, 32), mid: barbell(trunkPoint(skel, 0, 7.6)) }
    },
    thumb: 1,
    cues: {
      default: ['Upper back on the bench', 'Drive the hips up until level', 'Squeeze the glutes at the top'],
      floor: ['Lie with knees bent, feet flat', 'Lift the hips off the floor', 'Squeeze the glutes, then lower'],
    },
  },

  glute_kickback: {
    label: 'Glute kickback',
    keys: () => {
      const base = { anchor: 'ankle2', at: [50, FOOT], trunk: 140, leg2: [14, 0, 90], arm: { to: [72, 56], bend: -1 } }
      return [{ ...base, leg: [16, -18, 80] }, { ...base, leg: [-58, -64, -10] }]
    },
    gear: ({ j }) => ({ back: [...cableColumn(80, 40)], front: cable([78.5, 86], j.ankle) }),
    thumb: 1,
    cues: { default: ['Hold the machine, lean forward', 'Kick the leg straight back', 'Squeeze the glute, return slowly'] },
  },

  swing: {
    label: 'Kettlebell swing',
    keys: () => [
      { ...stand(50), trunk: 116, leg: [36, -12, 90], arm: [-28, -30] },
      { ...stand(50), trunk: 184, leg: [0, 0, 90], arm: [90, 92] },
    ],
    gear: ({ j, skel }) => ({ front: kettlebell(j.hand, dir(skel.angles.arm[1])) }),
    thumb: 1,
    cues: { default: ['Hike the bell back between the legs', 'Snap the hips forward', 'Let it float to chest height'] },
  },

  hip_machine: {
    label: 'Hip machine',
    view: 'front',
    keys: (v) => {
      const base = { at: [50, 70], trunk: 180, arm: [14, 4], fs: { leg: [0.3, 1] } }
      const together = { ...base, leg: [4, 2, 90] }
      const apart = { ...base, leg: [42, 16, 90] }
      return pick(v, 'dir') === 'in' ? [apart, together] : [together, apart]
    },
    gear: ({ v, j }) => {
      const side = pick(v, 'dir') === 'in' ? -1 : 1
      return { back: [pad([35, 77], [65, 77], 5), pad([50, 76], [50, 44], 9)], front: [dot(add(j.knee, [3.4 * side, 0]), 2.6, 'pad'), dot(add(j.knee2, [-3.4 * side, 0]), 2.6, 'pad')] }
    },
    thumb: 1,
    cues: {
      default: ['Sit tall, pads outside the knees', 'Push the knees apart', 'Return slowly'],
      in: ['Sit tall, pads inside the knees', 'Squeeze the knees together', 'Let them open slowly'],
    },
  },

  calf_raise: {
    label: 'Calf raise',
    keys: (v) => {
      if (pick(v, 'seat')) {
        const base = { anchor: 'toe', at: [64, G - 7], trunk: 182, arm: [20, 80] }
        return [{ ...base, leg: [90, 0, 118] }, { ...base, leg: [90, 0, 52] }]
      }
      const one = pick(v, 'gear') === 'dumbbell'
      const base = { anchor: 'toe', at: [57, G - 9], trunk: 180, leg: [0, 0, 118], arm: one ? [2, 2] : [-20, 140] }
      const legs2 = one ? { leg2: [6, -60, 40] } : {}
      return [{ ...base, ...legs2 }, { ...base, ...legs2, leg: [0, 0, 52], ...(one ? { leg2: [6, -60, 40] } : {}) }]
    },
    gear: ({ v, j }) => {
      const step = box(54, 70, G - 7.5)
      if (pick(v, 'seat')) return { back: [step, ...seat(40, 18, 77)], front: [dot(add(j.knee, [-2, -4.6]), 3, 'pad')] }
      if (pick(v, 'gear') === 'dumbbell') return { back: [step], front: dumbbell(j.hand), far: [] }
      return { back: [step, post([62, 26], [62, G])], front: [seg(add(j.shoulder, [0, -4]), [62, j.shoulder[1] - 4], 2, 'gear'), dot(add(j.shoulder, [0, -4]), 2.8, 'pad')] }
    },
    thumb: 1,
    cues: { default: ['Balls of the feet on the edge', 'Lower the heels for a stretch', 'Rise up as high as you can'] },
  },

  plank: {
    label: 'Plank',
    hold: true,
    keys: () => {
      const base = { anchor: 'toe', at: [17, G - 1], arm: [0, 90] }
      return [{ ...base, trunk: 100, leg: [-80, -80, 15] }, { ...base, trunk: 101, leg: [-79, -79, 16] }]
    },
    gear: () => ({}),
    cues: { default: ['Elbows under the shoulders', 'Body in one straight line', 'Brace and breathe — hold for time'] },
  },

  side_plank: {
    label: 'Side plank',
    view: 'front',
    hold: true,
    keys: () => {
      const base = { anchor: 'elbow', at: [70, G - 2.4], leg: [4, 0, 90], leg2: [-2, 0, 90], arm: [70, 160], arm2: [110, 180] }
      return [{ ...base, trunk: 112 }, { ...base, trunk: 114 }]
    },
    gear: () => ({}),
    cues: { default: ['Elbow under the shoulder', 'Hips up, body straight', 'Hold for time, then switch sides'] },
  },

  crunch: {
    label: 'Crunch',
    keys: (v) => {
      const style = pick(v, 'style', 'floor')
      if (style === 'cable') {
        const base = { anchor: 'knee', at: [44, G - 3.4], leg: [0, -90, -100], arm: { to: { from: 'shoulder', local: [5, 5] }, bend: -1 } }
        return [{ ...base, trunk: 165, head: 0 }, { ...base, trunk: 82, head: 18 }]
      }
      if (style === 'machine') {
        const base = seated(44, { arm: { to: { from: 'shoulder', local: [4, 4] }, bend: -1 } })
        return [{ ...base, trunk: 184, head: 0 }, { ...base, trunk: 140, head: 12 }]
      }
      const base = { at: [52, G - 4.6], leg: { to: [70, FOOT], bend: 1, foot: 90 } }
      return [{ ...base, trunk: -88, head: 0, arm: crossed(-88) }, { ...base, trunk: -126, head: -12, arm: crossed(-126) }]
    },
    gear: ({ v, j, skel0 }) => {
      const style = pick(v, 'style', 'floor')
      if (style === 'cable') return { back: cableColumn(70, 2), front: cable([68.5, 8], j.hand) }
      if (style === 'machine') return { back: [...seat(44), ...backrest(skel0, 0, 25)], front: [dot(j.hand, 2, 'gear')] }
      return { back: [pad([20, G - 0.6], [80, G - 0.6], 1.6)] }
    },
    thumb: 1,
    cues: {
      default: ['Knees bent, lower back down', 'Curl the shoulders up off the floor', 'Lower slowly'],
      cable: ['Kneel, rope by your head', 'Curl down, elbows toward the knees', 'Hips stay still'],
      machine: ['Hold the handles', 'Curl the chest toward the hips', 'Return slowly'],
    },
  },

  hanging_raise: {
    label: 'Hanging raise',
    keys: (v) => {
      const knees = pick(v, 'style') === 'knee'
      return [
        { anchor: 'hand', at: [50, 10], trunk: 180, arm: [180, 180], leg: [2, 0, 70] },
        { anchor: 'hand', at: [50, 10], trunk: 186, arm: [184, 180], leg: knees ? [104, 6, 80] : [96, 96, 170] },
      ]
    },
    gear: () => ({ back: pullupBar([50, 10]) }),
    thumb: 1,
    cues: {
      default: ['Hang from the bar', 'Raise straight legs to hip height', 'Lower without swinging'],
      knee: ['Hang from the bar', 'Bring the knees up to the chest', 'Lower without swinging'],
    },
  },

  rollout: {
    label: 'Ab wheel rollout',
    keys: () => [
      { anchor: 'knee', at: [36, G - 3.4], trunk: 122, leg: [-20, -90, -100], arm: { to: [62, G - 3.6], bend: -1 } },
      { anchor: 'knee', at: [36, G - 3.4], trunk: 99, leg: [-76, -90, -100], arm: { to: [97, G - 3.6], bend: -1 } },
    ],
    gear: ({ j }) => ({ front: [ring(j.hand, 3.6, 1.6, 'gear', 'plate')] }),
    thumb: 1,
    cues: { default: ['Kneel, hands on the wheel', 'Roll out with a flat back', 'Pull back with the abs'] },
  },

  twist: {
    label: 'Twist',
    view: 'front',
    keys: (v) => {
      if (pick(v, 'style') === 'woodchop') {
        const base = { at: [50, 58], trunk: 180, leg: [10, 2, 90] }
        return [{ ...base, trunk: 192, arm: [150, 160], arm2: [-110, -120] }, { ...base, trunk: 170, arm: [-40, -30], arm2: [30, 20] }]
      }
      const base = { at: [50, 80], leg: [24, -8, 90], fs: { trunk: 0.86, leg: [0.4, 0.75] } }
      return [{ ...base, trunk: 194, arm: [12, -36], arm2: [-52, -84] }, { ...base, trunk: 166, arm: [-52, -84], arm2: [12, -36] }]
    },
    gear: ({ v, j }) => (pick(v, 'style') === 'woodchop' ? { front: dumbbell(j.hand) } : { front: [dot([(j.hand[0] + j.hand2[0]) / 2, (j.hand[1] + j.hand2[1]) / 2], 3.4, 'gear')] }),
    smooth: false,
    cues: {
      default: ['Sit back, feet up', 'Turn the shoulders side to side', 'Move the weight from hip to hip'],
      woodchop: ['Start high to one side', 'Chop down across the body', 'Turn through the hips'],
    },
  },

  dead_bug: {
    label: 'Dead bug',
    keys: () => [
      { at: [56, G - 4.6], trunk: -90, arm: [266, 270], arm2: [180, 180], leg: [180, 92, 180], leg2: [96, 92, 170] },
      { at: [56, G - 4.6], trunk: -90, arm: [180, 180], arm2: [266, 270], leg: [96, 92, 170], leg2: [180, 92, 180] },
    ],
    gear: () => ({ back: [pad([20, G - 0.6], [84, G - 0.6], 1.6)] }),
    cues: { default: ['Lie on your back, lower back flat', 'Reach one arm and the other leg away', 'Return and switch sides'] },
  },

  pallof: {
    label: 'Pallof press',
    keys: () => {
      const base = { ...stand(48), leg: [6, 0, 90] }
      return [{ ...base, arm: { to: { from: 'shoulder', local: [-4, 7] }, bend: -1 } }, { ...base, arm: { to: { from: 'shoulder', local: [-2, 24] }, bend: -1 } }]
    },
    gear: ({ j, j0 }) => ({ back: [post([28, 30], [28, G], 3)], front: cable([29.5, j0.hand[1]], j.hand) }),
    thumb: 1,
    cues: { default: ['Stand side-on to the cable', 'Press the handle straight out', 'Don’t let it twist you'] },
  },

  mountain_climber: {
    label: 'Mountain climber',
    smooth: false,
    hold: false,
    keys: () => {
      const base = { anchor: 'hand', at: [72, PALM], trunk: 108, arm: [4, 4] }
      return [{ ...base, leg: [52, -62, 20], leg2: [-72, -72, 10] }, { ...base, leg: [-72, -72, 10], leg2: [52, -62, 20] }]
    },
    gear: () => ({}),
    cues: { default: ['Hands under the shoulders', 'Drive the knees in, one at a time', 'Keep the hips low'] },
  },

  power_clean: {
    label: 'Power clean',
    loop: 'cycle',
    keys: () => [
      { ...stand(48), trunk: 128, leg: [78, -18, 90], lift: 0, arm: { to: [51, G - PLATE_R], bend: -1 }, fs: { arm: [1, 1] } },
      { ...stand(48), trunk: 188, leg: [-4, -4, 50], lift: 2.4, arm: { to: [50.5, 59], bend: -1 }, fs: { arm: [1, 1] } },
      // Caught in the front rack (same point as frontRack, written out so the keys blend).
      { ...stand(48), trunk: 168, leg: [40, -18, 90], lift: 0, arm: { to: [53.5, 41.6], bend: -1 }, fs: RACK_FS },
    ],
    gear: ({ j, skel }) => ({ back: barbell(skel.joints.fist || hand(j)) }),
    thumb: 2,
    cues: { default: ['Start like a deadlift', 'Jump and shrug, pull the bar high', 'Catch it on your shoulders'] },
  },

  burpee: {
    label: 'Burpee',
    keys: () => [
      { at: [50, 56.7], trunk: 180, leg: { to: [50, FOOT], bend: 1, foot: 90 }, arm: { to: [52, 12], bend: -1 } },
      { at: [44, 76], trunk: 128, leg: { to: [52, FOOT], bend: 1, foot: 90 }, arm: { to: [62, PALM], bend: -1 } },
      { at: [42, 79], trunk: 106, leg: { to: [10, G - 5], bend: 1, foot: 20 }, arm: { to: [64, PALM], bend: -1 } },
    ],
    gear: () => ({}),
    thumb: 2,
    cues: { default: ['Squat and put your hands down', 'Jump the feet back to a plank', 'Jump back in and up'] },
  },

  run: {
    label: 'Run',
    smooth: true,
    keys: () => [
      { at: [48, 57], trunk: 172, leg: [40, -10, 100], leg2: [-24, -95, 10], arm: [-38, 50], arm2: [36, 120] },
      { at: [48, 57], trunk: 172, leg: [-24, -95, 10], leg2: [40, -10, 100], arm: [36, 120], arm2: [-38, 50] },
    ],
    gear: () => ({ back: [pad([16, G + 0.4], [82, G + 0.4], 2.4), post([80, G], [74, 46], 2.4), post([74, 46], [62, 50], 2)] }),
    cues: { default: ['Run tall, relaxed shoulders', 'Land softly under your hips', 'Steady breathing'] },
  },

  bike: {
    label: 'Bike',
    loop: 'spin',
    smooth: true,
    keys: (v) => {
      const air = pick(v, 'air')
      return [0, 120, 240, 360].map((a) => ({
        at: [40, 54],
        trunk: 152,
        leg: { to: { c: [52, 82], r: 7, a }, bend: 1, foot: 100 },
        leg2: { to: { c: [52, 82], r: 7, a: a + 180 }, bend: 1, foot: 100 },
        arm: { to: air ? { c: [66, 42], r: [5, 0.01], a: a + 90 } : [68, 46], bend: -1 },
        arm2: { to: air ? { c: [66, 42], r: [5, 0.01], a: a - 90 } : [68, 46], bend: -1 },
      }))
    },
    gear: ({ v, j }) => ({
      back: [pad([33, 59], [45, 59], 3), post([39, 60], [50, 80], 2.4), ring([52, 82], 7, 1.2, 'frame'), post([52, 82], [70, 44], 2.4), seg([66, 44], [72, 44], 2.6, 'gear'), post([30, G - 1], [76, G - 1], 2.4)],
      front: [seg(j.toe, j.heel, 1.6, 'gear')],
    }),
    cues: { default: ['Seat at hip height', 'Smooth circles with the legs', 'Keep a steady pace'] },
  },

  rower: {
    label: 'Rower',
    keys: () => [
      { at: [42, 79], trunk: 150, leg: { to: [66, 81], bend: 1, foot: 160 }, arm: { to: [72, 74], bend: -1 } },
      { at: [30, 79], trunk: 196, leg: { to: [66, 81], bend: 1, foot: 160 }, arm: { to: [41, 66], bend: -1 } },
    ],
    gear: ({ j }) => ({ back: [seg([10, 86], [86, 86], 2.2, 'frame'), pad(add(j.hip, [-7, 7]), add(j.hip, [5, 7]), 3), pad([70, 76], [70, 86], 3), ring([84, 76], 6, 1.6, 'frame', 'plate')], front: cable([82, 74], j.hand) }),
    cues: { default: ['Push with the legs first', 'Lean back, then pull to the ribs', 'Arms, body, legs on the way back'] },
  },

  elliptical: {
    label: 'Elliptical',
    loop: 'spin',
    smooth: true,
    keys: () => [0, 120, 240, 360].map((a) => ({
      at: [46, 52],
      trunk: 178,
      leg: { to: { c: [50, 82], r: [9, 3.2], a }, bend: 1, foot: 92 },
      leg2: { to: { c: [50, 82], r: [9, 3.2], a: a + 180 }, bend: 1, foot: 92 },
      arm: { to: { c: [62, 38], r: [5, 0.01], a: a + 180 }, bend: -1 },
      arm2: { to: { c: [62, 38], r: [5, 0.01], a }, bend: -1 },
    })),
    gear: ({ j }) => ({ back: [post([30, G - 1], [82, G - 1], 2.4), post([76, G], [70, 24], 2.4)], front: [seg(add(j.heel, [-2, 2]), add(j.toe, [2, 2]), 2, 'gear'), seg(j.hand, [70, 30], 1.6, 'gear')] }),
    cues: { default: ['Stand tall, hold the handles', 'Push and pull in a smooth loop', 'Keep the heels down'] },
  },

  stairs: {
    label: 'Stair climber',
    keys: () => [
      { at: [46, 50], trunk: 174, leg: { to: [56, 70], bend: 1, foot: 90 }, leg2: { to: [48, 86], bend: 1, foot: 90 }, arm: { to: [64, 48], bend: -1 } },
      { at: [50, 40], trunk: 176, leg: { to: [56, 70], bend: 1, foot: 90 }, leg2: { to: [62, 60], bend: 1, foot: 70 }, arm: { to: [64, 48], bend: -1 } },
    ],
    gear: () => ({ back: [box(28, 50, 88 + 2), box(50, 72, 72 + 2), box(72, 90, 56 + 2), post([80, 56], [70, 46], 2)] }),
    cues: { default: ['Stand tall, light grip', 'Step with the whole foot', 'Steady pace'] },
  },

  jump_rope: {
    label: 'Jump rope',
    keys: () => [
      { anchor: 'toe', at: [53, G - 1], trunk: 180, leg: [4, -6, 70], arm: [24, 80] },
      { anchor: 'toe', at: [53, G - 6], trunk: 180, leg: [2, -2, 40], arm: [24, 80] },
    ],
    gear: ({ j }) => ({ back: [ring([j.hip[0], j.hip[1] - 4], 30, 1, 'thin')] }),
    cues: { default: ['Small jumps on the balls of the feet', 'Turn the rope with the wrists', 'Elbows close to the body'] },
  },
}

// The loop style and keyframe used for still images, which some variants change.
export function patternInfo(id, variant = {}) {
  const pattern = PATTERNS[id]
  if (!pattern) return null
  const keyed = (map) => {
    if (!map || !variant) return undefined
    for (const [key, value] of Object.entries(map)) if (Object.values(variant).includes(key) || variant[key]) return value
    return undefined
  }
  const keys = pattern.keys(variant || {})
  const thumb = keyed(pattern.thumbFor) ?? pattern.thumb ?? keys.length - 1
  return {
    id,
    pattern,
    keys,
    view: pattern.view || 'side',
    loop: keyed(pattern.loopFor) || pattern.loop || 'pingpong',
    smooth: Boolean(pattern.smooth),
    hold: Boolean(pattern.hold),
    thumb: Math.min(keys.length - 1, Math.max(0, thumb)),
  }
}

// Short form cues for a pattern + variant (the variant's own cues when it has them).
export function cuesFor(id, variant = {}) {
  const cues = PATTERNS[id]?.cues
  if (!cues) return []
  for (const value of Object.values(variant || {})) if (typeof value === 'string' && cues[value]) return cues[value]
  for (const [key, value] of Object.entries(variant || {})) if (value === true && cues[key]) return cues[key]
  return cues.default || []
}

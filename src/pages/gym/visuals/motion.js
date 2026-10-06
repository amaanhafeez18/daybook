// Which motion pattern (and variant) shows each exercise. Every built-in library id has an explicit
// entry; custom exercises are matched from their name, then their movement, equipment and primary
// muscle. Pure module (kept out of lib/gym/library.js, which must stay free of UI concerns).

// [pattern, variant]
export const EXERCISE_MOTION = {
  'bench-press': ['bench_press', { bench: 'flat', gear: 'barbell' }],
  'incline-bench-press': ['bench_press', { bench: 'incline', gear: 'barbell' }],
  'decline-bench-press': ['bench_press', { bench: 'decline', gear: 'barbell' }],
  'close-grip-bench-press': ['bench_press', { bench: 'flat', gear: 'barbell', grip: 'close' }],
  'dumbbell-bench-press': ['bench_press', { bench: 'flat', gear: 'dumbbell' }],
  'incline-dumbbell-press': ['bench_press', { bench: 'incline', gear: 'dumbbell' }],
  'dumbbell-fly': ['chest_fly', { gear: 'dumbbell' }],
  'cable-crossover': ['chest_fly', { gear: 'cable' }],
  'pec-deck': ['chest_fly', { gear: 'machine' }],
  'chest-press-machine': ['machine_press', { bench: 'flat' }],
  'incline-chest-press-machine': ['machine_press', { bench: 'incline' }],
  'smith-bench-press': ['bench_press', { bench: 'flat', gear: 'smith' }],
  'push-up': ['push_up', {}],
  'chest-dip': ['dip', {}],
  'weighted-dip': ['dip', { belt: true }],
  'dumbbell-pullover': ['pullover', { gear: 'dumbbell' }],
  'deadlift': ['hinge', { style: 'deadlift', gear: 'barbell' }],
  'sumo-deadlift': ['hinge', { style: 'sumo', gear: 'barbell' }],
  'trap-bar-deadlift': ['hinge', { style: 'trap', gear: 'barbell' }],
  'barbell-row': ['row_bent', { gear: 'barbell' }],
  't-bar-row': ['row_bent', { gear: 'landmine' }],
  'dumbbell-row': ['row_one_arm', { gear: 'dumbbell' }],
  'chest-supported-row': ['row_supported', { gear: 'dumbbell' }],
  'seated-cable-row': ['row_seated', { gear: 'cable' }],
  'machine-row': ['row_seated', { gear: 'machine' }],
  'lat-pulldown': ['pulldown', { gear: 'cable' }],
  'machine-lat-pulldown': ['pulldown', { gear: 'machine' }],
  'straight-arm-pulldown': ['straight_arm_pulldown', { gear: 'cable' }],
  'pull-up': ['pull_up', {}],
  'chin-up': ['pull_up', { grip: 'chin' }],
  'weighted-pull-up': ['pull_up', { belt: true }],
  'assisted-pull-up': ['pull_up', { assist: 'machine' }],
  'band-assisted-pull-up': ['pull_up', { assist: 'band' }],
  'inverted-row': ['inverted_row', {}],
  'back-extension': ['back_extension', {}],
  'good-morning': ['hinge', { style: 'good_morning', gear: 'barbell' }],
  'face-pull': ['face_pull', { gear: 'cable' }],
  'band-pull-apart': ['pull_apart', { gear: 'band' }],
  'barbell-shrug': ['shrug', { gear: 'barbell' }],
  'dumbbell-shrug': ['shrug', { gear: 'dumbbell' }],
  'upright-row': ['upright_row', { gear: 'barbell' }],
  'farmers-walk': ['carry', { gear: 'dumbbell' }],
  'overhead-press': ['overhead_press', { gear: 'barbell' }],
  'seated-dumbbell-press': ['overhead_press', { gear: 'dumbbell', seat: true }],
  'arnold-press': ['overhead_press', { gear: 'dumbbell', seat: true, arnold: true }],
  'machine-shoulder-press': ['overhead_press', { gear: 'machine', seat: true }],
  'push-press': ['overhead_press', { gear: 'barbell', dip: true }],
  'landmine-press': ['overhead_press', { gear: 'landmine' }],
  'pike-push-up': ['push_up', { style: 'pike' }],
  'lateral-raise': ['lateral_raise', { gear: 'dumbbell' }],
  'cable-lateral-raise': ['lateral_raise', { gear: 'cable' }],
  'machine-lateral-raise': ['lateral_raise', { gear: 'machine' }],
  'front-raise': ['front_raise', { gear: 'dumbbell' }],
  'rear-delt-fly': ['rear_delt_fly', { gear: 'dumbbell' }],
  'cable-rear-delt-fly': ['rear_delt_fly', { gear: 'cable' }],
  'reverse-pec-deck': ['rear_delt_fly', { gear: 'machine' }],
  'barbell-curl': ['curl', { gear: 'barbell' }],
  'ez-bar-curl': ['curl', { gear: 'barbell' }],
  'dumbbell-curl': ['curl', { gear: 'dumbbell' }],
  'hammer-curl': ['curl', { gear: 'dumbbell', grip: 'hammer' }],
  'incline-dumbbell-curl': ['curl', { gear: 'dumbbell', style: 'incline' }],
  'preacher-curl': ['curl', { gear: 'barbell', style: 'preacher' }],
  'cable-curl': ['curl', { gear: 'cable' }],
  'cable-hammer-curl': ['curl', { gear: 'cable', grip: 'hammer' }],
  'concentration-curl': ['curl', { gear: 'dumbbell', style: 'concentration' }],
  'triceps-pushdown': ['pushdown', { gear: 'cable' }],
  'overhead-cable-extension': ['overhead_extension', { gear: 'cable' }],
  'skull-crusher': ['skull_crusher', { gear: 'barbell' }],
  'overhead-dumbbell-extension': ['overhead_extension', { gear: 'dumbbell' }],
  'triceps-kickback': ['kickback', { gear: 'dumbbell' }],
  'machine-triceps-extension': ['pushdown', { gear: 'machine', seat: true }],
  'bench-dip': ['dip', { style: 'bench' }],
  'assisted-dip': ['dip', { assist: 'machine' }],
  'diamond-push-up': ['push_up', { style: 'diamond' }],
  'wrist-curl': ['wrist_curl', { gear: 'dumbbell' }],
  'reverse-curl': ['curl', { gear: 'barbell', grip: 'reverse' }],
  'dead-hang': ['dead_hang', {}],
  'back-squat': ['squat', { hold: 'back' }],
  'front-squat': ['squat', { hold: 'front' }],
  'goblet-squat': ['squat', { hold: 'goblet' }],
  'smith-squat': ['squat', { hold: 'smith' }],
  'hack-squat': ['squat', { hold: 'hack' }],
  'leg-press': ['leg_press', {}],
  'bodyweight-squat': ['squat', { hold: 'none' }],
  'bulgarian-split-squat': ['lunge', { style: 'bulgarian', gear: 'dumbbell' }],
  'walking-lunge': ['lunge', { style: 'walking', gear: 'dumbbell' }],
  'reverse-lunge': ['lunge', { style: 'reverse', gear: 'barbell' }],
  'step-up': ['step_up', { gear: 'dumbbell' }],
  'leg-extension': ['leg_extension', {}],
  'hip-adduction': ['hip_machine', { dir: 'in' }],
  'hip-abduction': ['hip_machine', { dir: 'out' }],
  'romanian-deadlift': ['hinge', { style: 'rdl', gear: 'barbell' }],
  'dumbbell-romanian-deadlift': ['hinge', { style: 'rdl', gear: 'dumbbell' }],
  'single-leg-rdl': ['hinge', { style: 'single_leg', gear: 'dumbbell' }],
  'lying-leg-curl': ['leg_curl', { style: 'lying' }],
  'seated-leg-curl': ['leg_curl', { style: 'seated' }],
  'nordic-curl': ['nordic', {}],
  'hip-thrust': ['hip_thrust', { style: 'bench' }],
  'glute-bridge': ['hip_thrust', { style: 'floor' }],
  'cable-kickback': ['glute_kickback', { gear: 'cable' }],
  'kettlebell-swing': ['swing', { gear: 'kettlebell' }],
  'standing-calf-raise': ['calf_raise', { gear: 'machine' }],
  'seated-calf-raise': ['calf_raise', { seat: true }],
  'dumbbell-calf-raise': ['calf_raise', { gear: 'dumbbell' }],
  'plank': ['plank', {}],
  'side-plank': ['side_plank', {}],
  'crunch': ['crunch', { style: 'floor' }],
  'hanging-leg-raise': ['hanging_raise', { style: 'leg' }],
  'hanging-knee-raise': ['hanging_raise', { style: 'knee' }],
  'cable-crunch': ['crunch', { style: 'cable' }],
  'machine-crunch': ['crunch', { style: 'machine' }],
  'ab-wheel-rollout': ['rollout', {}],
  'russian-twist': ['twist', { style: 'russian' }],
  'dead-bug': ['dead_bug', {}],
  'pallof-press': ['pallof', { gear: 'cable' }],
  'mountain-climber': ['mountain_climber', {}],
  'power-clean': ['power_clean', { gear: 'barbell' }],
  'burpee': ['burpee', {}],
  'treadmill': ['run', {}],
  'stationary-bike': ['bike', {}],
  'air-bike': ['bike', { air: true }],
  'rowing-machine': ['rower', {}],
  'elliptical': ['elliptical', {}],
  'stair-climber': ['stairs', {}],
}

// ---- custom exercises ------------------------------------------------------------------------

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Name keywords, most specific first. A function variant can look at the exercise's equipment.
const RULES = [
  [/\b(jump rope|skipping|skip rope|double unders?)\b/, 'jump_rope'],
  [/\b(air bike|assault bike|echo bike)\b/, 'bike', { air: true }],
  [/\b(bike|cycling|cycle|spin)\b/, 'bike'],
  [/\b(rowing|rower|erg|ergometer)\b/, 'rower'],
  [/\b(elliptical|cross trainer)\b/, 'elliptical'],
  [/\b(stair|stairs|stairmaster|step mill|stepper)\b/, 'stairs'],
  [/\b(treadmill|running|run|jog|jogging|sprints?)\b/, 'run'],
  [/\bburpees?\b/, 'burpee'],
  [/\bmountain climbers?\b/, 'mountain_climber'],
  [/\b(clean|snatch|clean and jerk)\b/, 'power_clean'],
  [/\b(farmer|farmers|carry|suitcase)\b/, 'carry'],
  [/\b(skull ?crushers?|lying (triceps?|tricep) extension)\b/, 'skull_crusher'],
  [/\bpullovers?\b/, 'pullover'],
  [/\bface pulls?\b/, 'face_pull'],
  [/\bpull ?aparts?\b/, 'pull_apart'],
  [/\b(glute|donkey|hip) kick ?backs?\b/, 'glute_kickback'],
  [/\bkick ?backs?\b/, (e) => (e.primary === 'glutes' ? ['glute_kickback', {}] : ['kickback', {}])],
  [/\b(push ?downs?|press ?downs?)\b/, 'pushdown'],
  [/\b(overhead|french press|behind the head)\b.*\b(extension|triceps?|press)\b|\b(triceps?|tricep) extension\b/, 'overhead_extension'],
  [/\bwrist curls?\b/, 'wrist_curl'],
  [/\b(leg|hamstring) curls?\b/, (e, name) => ['leg_curl', { style: /\bseated\b/.test(name) ? 'seated' : 'lying' }]],
  [/\bnordic\b/, 'nordic'],
  [/\bpreacher\b/, 'curl', { style: 'preacher' }],
  [/\bconcentration\b/, 'curl', { style: 'concentration' }],
  [/\bincline\b.*\bcurls?\b/, 'curl', { style: 'incline' }],
  [/\bhammer\b/, 'curl', { grip: 'hammer' }],
  [/\breverse curls?\b/, 'curl', { grip: 'reverse' }],
  [/\bcurls?\b/, 'curl'],
  [/\bleg extensions?\b/, 'leg_extension'],
  [/\bleg press\b/, 'leg_press'],
  [/\bhack squats?\b/, 'squat', { hold: 'hack' }],
  [/\bfront squats?\b/, 'squat', { hold: 'front' }],
  [/\bgoblet\b/, 'squat', { hold: 'goblet' }],
  [/\b(split squats?|bulgarian)\b/, 'lunge', { style: 'bulgarian' }],
  [/\breverse lunges?\b/, 'lunge', { style: 'reverse' }],
  [/\blunges?\b/, 'lunge', { style: 'walking' }],
  [/\bstep ?ups?\b/, 'step_up'],
  [/\b(squats?|wall sit)\b/, 'squat'],
  [/\bcalf\b|\bcalves\b/, (e, name) => ['calf_raise', /\bseated\b/.test(name) ? { seat: true } : {}]],
  [/\bhip thrusts?\b/, 'hip_thrust', { style: 'bench' }],
  [/\b(glute )?bridges?\b/, 'hip_thrust', { style: 'floor' }],
  [/\babduct/, 'hip_machine', { dir: 'out' }],
  [/\badduct/, 'hip_machine', { dir: 'in' }],
  [/\b(romanian|rdl|stiff leg(ged)?)\b/, (e, name) => ['hinge', { style: /\b(single|one) leg\b/.test(name) ? 'single_leg' : 'rdl' }]],
  [/\bgood mornings?\b/, 'hinge', { style: 'good_morning' }],
  [/\bsumo\b/, 'hinge', { style: 'sumo' }],
  [/\bdeadlifts?\b/, (e, name) => ['hinge', { style: /\btrap\b|\bhex\b/.test(name) ? 'trap' : 'deadlift' }]],
  [/\bswings?\b/, 'swing'],
  [/\b(back extensions?|hyperextensions?|superman)\b/, 'back_extension'],
  [/\bshrugs?\b/, 'shrug'],
  [/\bupright rows?\b/, 'upright_row'],
  [/\bstraight arm\b/, 'straight_arm_pulldown'],
  [/\b(pull ?downs?|lat pull)\b/, 'pulldown'],
  [/\bhanging\b.*\b(leg|knee)\b|\b(leg|knee) raises?\b|\btoes to bar\b/, (e, name) => ['hanging_raise', { style: /\bknee/.test(name) ? 'knee' : 'leg' }]],
  [/\bdead hang\b|\bhang\b/, 'dead_hang'],
  [/\b(pull ?ups?|chin ?ups?|muscle ups?)\b/, (e, name) => ['pull_up', /\bchin/.test(name) ? { grip: 'chin' } : {}]],
  [/\b(inverted|australian) rows?\b/, 'inverted_row'],
  [/\b(t bar|landmine) rows?\b/, 'row_bent', { gear: 'landmine' }],
  [/\b(chest supported|seal|incline) rows?\b/, 'row_supported'],
  [/\b(one arm|single arm|kroc) rows?\b/, 'row_one_arm'],
  [/\b(seated|cable) rows?\b/, (e) => ['row_seated', { gear: e.equipment === 'machine' ? 'machine' : 'cable' }]],
  [/\brows?\b/, (e) => (e.equipment === 'machine' || e.equipment === 'cable' ? ['row_seated', { gear: e.equipment }] : e.equipment === 'dumbbell' ? ['row_one_arm', {}] : ['row_bent', {}])],
  [/\b(rear delt|reverse fly|reverse flye|reverse pec)\b/, 'rear_delt_fly'],
  [/\b(lateral|side) raises?\b|\blaterals?\b/, 'lateral_raise'],
  [/\bfront raises?\b/, 'front_raise'],
  [/\b(fly|flyes?|flies|crossovers?|pec deck)\b/, 'chest_fly'],
  [/\bdips?\b/, (e, name) => ['dip', /\bbench\b/.test(name) ? { style: 'bench' } : {}]],
  [/\b(push ?ups?|press ?ups?)\b/, (e, name) => ['push_up', /\bpike\b/.test(name) ? { style: 'pike' } : {}]],
  [/\bpush press\b/, 'overhead_press', { dip: true }],
  [/\blandmine press\b/, 'overhead_press', { gear: 'landmine' }],
  [/\b(arnold|shoulder press|overhead press|military|ohp)\b/, 'overhead_press'],
  [/\b(bench|chest press|floor press|incline press|decline press|smith press)\b/, (e, name) => (e.equipment === 'machine' ? ['machine_press', { bench: /\bincline\b/.test(name) ? 'incline' : 'flat' }] : ['bench_press', { bench: /\bincline\b/.test(name) ? 'incline' : /\bdecline\b/.test(name) ? 'decline' : 'flat' }])],
  [/\bside planks?\b/, 'side_plank'],
  [/\bplanks?\b|\bhollow hold\b/, 'plank'],
  [/\b(ab wheel|roll ?outs?)\b/, 'rollout'],
  [/\b(russian twists?|twists?)\b/, 'twist', { style: 'russian' }],
  [/\b(woodchops?|wood chops?)\b/, 'twist', { style: 'woodchop' }],
  [/\b(dead bugs?|bird dogs?)\b/, 'dead_bug'],
  [/\bpallof\b/, 'pallof'],
  [/\b(crunch|crunches|sit ?ups?)\b/, (e) => ['crunch', { style: e.equipment === 'cable' ? 'cable' : e.equipment === 'machine' ? 'machine' : 'floor' }]],
  // Generic "press" last: decided by the muscle it works.
  [/\bpress\b/, (e) => (e.primary === 'shoulders' ? ['overhead_press', {}] : ['quads', 'glutes'].includes(e.primary) ? ['leg_press', {}] : e.primary === 'chest' ? ['bench_press', {}] : null)],
]

// When the name says nothing: the muscle it mainly works (and the kind of movement).
function byMuscle(entry) {
  const { primary, movement, equipment } = entry
  switch (primary) {
    case 'chest': return equipment === 'machine' ? ['machine_press', {}] : equipment === 'bodyweight' ? ['push_up', {}] : ['bench_press', {}]
    case 'shoulders': return movement === 'pull' ? ['rear_delt_fly', {}] : ['overhead_press', {}]
    case 'triceps': return ['pushdown', {}]
    case 'biceps': return ['curl', {}]
    case 'forearms': return ['wrist_curl', {}]
    case 'lats': return equipment === 'bodyweight' ? ['pull_up', {}] : ['pulldown', {}]
    case 'upper_back': return equipment === 'cable' || equipment === 'machine' ? ['row_seated', {}] : ['row_bent', {}]
    case 'traps': return ['shrug', {}]
    case 'lower_back': return ['back_extension', {}]
    case 'quads': return ['squat', {}]
    case 'hamstrings': return ['hinge', { style: 'rdl' }]
    case 'glutes': return ['hip_thrust', {}]
    case 'calves': return ['calf_raise', {}]
    case 'adductors': return ['hip_machine', { dir: 'in' }]
    case 'abductors': return ['hip_machine', { dir: 'out' }]
    case 'abs': return ['crunch', {}]
    case 'cardio': return ['run', {}]
    default: return movement === 'cardio' ? ['run', {}] : null
  }
}

// The gear an equipment id draws as (only for patterns that draw gear from the variant).
const GEAR = { barbell: 'barbell', dumbbell: 'dumbbell', kettlebell: 'kettlebell', cable: 'cable', machine: 'machine', smith_machine: 'smith', band: 'band', bodyweight: 'none' }
const GEAR_PATTERNS = {
  bench_press: ['barbell', 'dumbbell', 'smith'],
  overhead_press: ['barbell', 'dumbbell', 'machine', 'kettlebell'],
  curl: ['barbell', 'dumbbell', 'cable'],
  shrug: ['barbell', 'dumbbell'],
  lateral_raise: ['dumbbell', 'cable', 'machine'],
  rear_delt_fly: ['dumbbell', 'cable', 'machine'],
  chest_fly: ['dumbbell', 'cable', 'machine'],
  row_seated: ['cable', 'machine'],
  pulldown: ['cable', 'machine'],
  hinge: ['barbell', 'dumbbell', 'kettlebell'],
  lunge: ['barbell', 'dumbbell'],
  overhead_extension: ['dumbbell', 'cable'],
  calf_raise: ['machine', 'dumbbell'],
}

function withGear(pattern, variant, equipment) {
  const gear = GEAR[equipment]
  if (!gear || variant.gear || !GEAR_PATTERNS[pattern]?.includes(gear)) return variant
  return { ...variant, gear }
}

// Pattern + variant for a custom exercise, or null when nothing fits (then only the muscle map shows).
export function guessMotion(entry) {
  if (!entry || typeof entry !== 'object') return null
  const name = normalize(entry.name)
  for (const [pattern, target, variant] of RULES) {
    if (!pattern.test(name)) continue
    const found = typeof target === 'function' ? target(entry, name) : [target, variant || {}]
    if (found) return { pattern: found[0], variant: withGear(found[0], found[1] || {}, entry.equipment), guessed: true }
  }
  const found = byMuscle(entry)
  return found ? { pattern: found[0], variant: withGear(found[0], found[1] || {}, entry.equipment), guessed: true } : null
}

// The motion for any exercise entry: the explicit table for library ids, else a guess.
export function motionFor(entry) {
  if (!entry || typeof entry !== 'object') return null
  const own = typeof entry.id === 'string' && Object.prototype.hasOwnProperty.call(EXERCISE_MOTION, entry.id) ? EXERCISE_MOTION[entry.id] : null
  if (own && !entry.custom) return { pattern: own[0], variant: own[1], guessed: false }
  return guessMotion(entry)
}

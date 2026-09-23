// Built-in exercise library, labels, onboarding templates and exercise search.
// Pure module: the only import is the dependency-free schedule module.
import { emptySchedule } from './schedule.js'

const defaultId = () => Math.random().toString(36).slice(2, 10)
const nowIso = () => new Date().toISOString()
// Own-property lookup, so stored strings like 'constructor' never hit Object.prototype.
const own = (object, key) => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined)

export const MUSCLES = [
  { id: 'chest', label: 'Chest' },
  { id: 'lats', label: 'Lats' },
  { id: 'upper_back', label: 'Upper back' },
  { id: 'lower_back', label: 'Lower back' },
  { id: 'traps', label: 'Traps' },
  { id: 'shoulders', label: 'Shoulders' },
  { id: 'biceps', label: 'Biceps' },
  { id: 'triceps', label: 'Triceps' },
  { id: 'forearms', label: 'Forearms' },
  { id: 'abs', label: 'Abs' },
  { id: 'quads', label: 'Quads' },
  { id: 'hamstrings', label: 'Hamstrings' },
  { id: 'glutes', label: 'Glutes' },
  { id: 'calves', label: 'Calves' },
  { id: 'adductors', label: 'Adductors' },
  { id: 'abductors', label: 'Abductors' },
  { id: 'full_body', label: 'Full body' },
  { id: 'cardio', label: 'Cardio' },
]

export const EQUIPMENT = [
  { id: 'barbell', label: 'Barbell' },
  { id: 'dumbbell', label: 'Dumbbell' },
  { id: 'kettlebell', label: 'Kettlebell' },
  { id: 'machine', label: 'Machine' },
  { id: 'cable', label: 'Cable' },
  { id: 'smith_machine', label: 'Smith machine' },
  { id: 'band', label: 'Band' },
  { id: 'bodyweight', label: 'Bodyweight' },
]

// Input fields per tracking type: weight, added (weighted bodyweight), assist (assisted bodyweight),
// reps, duration (seconds) and distance (metres).
export const TRACKING = {
  weight_reps: { label: 'Weight & reps', fields: ['weight', 'reps'] },
  bodyweight_reps: { label: 'Bodyweight reps', fields: ['reps'] },
  reps_only: { label: 'Reps only', fields: ['reps'] },
  weighted_bodyweight: { label: 'Weighted bodyweight', fields: ['added', 'reps'] },
  assisted_bodyweight: { label: 'Assisted bodyweight', fields: ['assist', 'reps'] },
  duration: { label: 'Duration', fields: ['duration'] },
  weight_duration: { label: 'Weight & duration', fields: ['weight', 'duration'] },
  distance_duration: { label: 'Distance & duration', fields: ['distance', 'duration'] },
  weight_distance: { label: 'Weight & distance', fields: ['weight', 'distance'] },
}

// The spec's library, verbatim. Ids are stable slugs: never rename one (sessions reference them).
export const EXERCISES = [
  {"id":"bench-press","name":"Bench Press (Barbell)","primary":"chest","secondary":["triceps","shoulders"],"equipment":"barbell","category":"compound","movement":"push","tracking":"weight_reps","rest":180},
  {"id":"incline-bench-press","name":"Incline Bench Press (Barbell)","primary":"chest","secondary":["shoulders","triceps"],"equipment":"barbell","category":"compound","movement":"push","tracking":"weight_reps","rest":180},
  {"id":"decline-bench-press","name":"Decline Bench Press (Barbell)","primary":"chest","secondary":["triceps","shoulders"],"equipment":"barbell","category":"compound","movement":"push","tracking":"weight_reps","rest":180},
  {"id":"close-grip-bench-press","name":"Close-Grip Bench Press (Barbell)","primary":"triceps","secondary":["chest","shoulders"],"equipment":"barbell","category":"compound","movement":"push","tracking":"weight_reps","rest":180},
  {"id":"dumbbell-bench-press","name":"Bench Press (Dumbbell)","primary":"chest","secondary":["triceps","shoulders"],"equipment":"dumbbell","category":"compound","movement":"push","tracking":"weight_reps","rest":120},
  {"id":"incline-dumbbell-press","name":"Incline Bench Press (Dumbbell)","primary":"chest","secondary":["shoulders","triceps"],"equipment":"dumbbell","category":"compound","movement":"push","tracking":"weight_reps","rest":120},
  {"id":"dumbbell-fly","name":"Chest Fly (Dumbbell)","primary":"chest","secondary":["shoulders"],"equipment":"dumbbell","category":"isolation","movement":"push","tracking":"weight_reps","rest":90},
  {"id":"cable-crossover","name":"Cable Crossover","primary":"chest","secondary":["shoulders"],"equipment":"cable","category":"isolation","movement":"push","tracking":"weight_reps","rest":90},
  {"id":"pec-deck","name":"Pec Deck (Machine Fly)","primary":"chest","secondary":["shoulders"],"equipment":"machine","category":"isolation","movement":"push","tracking":"weight_reps","rest":90},
  {"id":"chest-press-machine","name":"Chest Press (Machine)","primary":"chest","secondary":["triceps","shoulders"],"equipment":"machine","category":"compound","movement":"push","tracking":"weight_reps","rest":120},
  {"id":"incline-chest-press-machine","name":"Incline Chest Press (Machine)","primary":"chest","secondary":["shoulders","triceps"],"equipment":"machine","category":"compound","movement":"push","tracking":"weight_reps","rest":120},
  {"id":"smith-bench-press","name":"Bench Press (Smith Machine)","primary":"chest","secondary":["triceps","shoulders"],"equipment":"smith_machine","category":"compound","movement":"push","tracking":"weight_reps","rest":120},
  {"id":"push-up","name":"Push-Up","primary":"chest","secondary":["triceps","shoulders","abs"],"equipment":"bodyweight","category":"compound","movement":"push","tracking":"bodyweight_reps","rest":120},
  {"id":"chest-dip","name":"Dip","primary":"chest","secondary":["triceps","shoulders"],"equipment":"bodyweight","category":"compound","movement":"push","tracking":"bodyweight_reps","rest":120,"bwVolume":true},
  {"id":"weighted-dip","name":"Weighted Dip","primary":"chest","secondary":["triceps","shoulders"],"equipment":"bodyweight","category":"compound","movement":"push","tracking":"weighted_bodyweight","rest":120,"bwVolume":true},
  {"id":"dumbbell-pullover","name":"Pullover (Dumbbell)","primary":"chest","secondary":["lats","triceps"],"equipment":"dumbbell","category":"isolation","movement":"push","tracking":"weight_reps","rest":90},
  {"id":"deadlift","name":"Deadlift (Barbell)","primary":"lower_back","secondary":["hamstrings","glutes","quads","traps","forearms"],"equipment":"barbell","category":"compound","movement":"pull","tracking":"weight_reps","rest":180},
  {"id":"sumo-deadlift","name":"Sumo Deadlift (Barbell)","primary":"glutes","secondary":["quads","hamstrings","adductors","lower_back","traps"],"equipment":"barbell","category":"compound","movement":"legs","tracking":"weight_reps","rest":180},
  {"id":"trap-bar-deadlift","name":"Trap Bar Deadlift","primary":"quads","secondary":["glutes","hamstrings","lower_back","traps"],"equipment":"barbell","category":"compound","movement":"legs","tracking":"weight_reps","rest":180,"bar":"trap"},
  {"id":"barbell-row","name":"Bent Over Row (Barbell)","primary":"upper_back","secondary":["lats","biceps","lower_back","forearms"],"equipment":"barbell","category":"compound","movement":"pull","tracking":"weight_reps","rest":180},
  {"id":"t-bar-row","name":"T-Bar Row","primary":"upper_back","secondary":["lats","biceps","lower_back"],"equipment":"barbell","category":"compound","movement":"pull","tracking":"weight_reps","rest":120,"bar":"landmine"},
  {"id":"dumbbell-row","name":"One-Arm Row (Dumbbell)","primary":"lats","secondary":["upper_back","biceps"],"equipment":"dumbbell","category":"compound","movement":"pull","tracking":"weight_reps","rest":120},
  {"id":"chest-supported-row","name":"Chest-Supported Row (Dumbbell)","primary":"upper_back","secondary":["lats","biceps","shoulders"],"equipment":"dumbbell","category":"compound","movement":"pull","tracking":"weight_reps","rest":120},
  {"id":"seated-cable-row","name":"Seated Cable Row","primary":"upper_back","secondary":["lats","biceps"],"equipment":"cable","category":"compound","movement":"pull","tracking":"weight_reps","rest":120},
  {"id":"machine-row","name":"Seated Row (Machine)","primary":"upper_back","secondary":["lats","biceps"],"equipment":"machine","category":"compound","movement":"pull","tracking":"weight_reps","rest":120},
  {"id":"lat-pulldown","name":"Lat Pulldown (Cable)","primary":"lats","secondary":["biceps","upper_back"],"equipment":"cable","category":"compound","movement":"pull","tracking":"weight_reps","rest":120},
  {"id":"machine-lat-pulldown","name":"Lat Pulldown (Machine)","primary":"lats","secondary":["biceps","upper_back"],"equipment":"machine","category":"compound","movement":"pull","tracking":"weight_reps","rest":120},
  {"id":"straight-arm-pulldown","name":"Straight-Arm Pulldown (Cable)","primary":"lats","secondary":["triceps"],"equipment":"cable","category":"isolation","movement":"pull","tracking":"weight_reps","rest":90},
  {"id":"pull-up","name":"Pull-Up","primary":"lats","secondary":["biceps","upper_back","forearms"],"equipment":"bodyweight","category":"compound","movement":"pull","tracking":"bodyweight_reps","rest":120,"bwVolume":true},
  {"id":"chin-up","name":"Chin-Up","primary":"lats","secondary":["biceps","upper_back"],"equipment":"bodyweight","category":"compound","movement":"pull","tracking":"bodyweight_reps","rest":120,"bwVolume":true},
  {"id":"weighted-pull-up","name":"Weighted Pull-Up","primary":"lats","secondary":["biceps","upper_back"],"equipment":"bodyweight","category":"compound","movement":"pull","tracking":"weighted_bodyweight","rest":120,"bwVolume":true},
  {"id":"assisted-pull-up","name":"Assisted Pull-Up (Machine)","primary":"lats","secondary":["biceps","upper_back"],"equipment":"machine","category":"compound","movement":"pull","tracking":"assisted_bodyweight","rest":120,"bwVolume":true},
  {"id":"band-assisted-pull-up","name":"Band-Assisted Pull-Up","primary":"lats","secondary":["biceps","upper_back"],"equipment":"band","category":"compound","movement":"pull","tracking":"reps_only","rest":120},
  {"id":"inverted-row","name":"Inverted Row","primary":"upper_back","secondary":["lats","biceps"],"equipment":"bodyweight","category":"compound","movement":"pull","tracking":"bodyweight_reps","rest":120},
  {"id":"back-extension","name":"Back Extension (Hyperextension)","primary":"lower_back","secondary":["glutes","hamstrings"],"equipment":"bodyweight","category":"isolation","movement":"pull","tracking":"bodyweight_reps","rest":90},
  {"id":"good-morning","name":"Good Morning (Barbell)","primary":"hamstrings","secondary":["lower_back","glutes"],"equipment":"barbell","category":"compound","movement":"legs","tracking":"weight_reps","rest":120},
  {"id":"face-pull","name":"Face Pull (Cable)","primary":"shoulders","secondary":["traps","upper_back"],"equipment":"cable","category":"isolation","movement":"pull","tracking":"weight_reps","rest":90},
  {"id":"band-pull-apart","name":"Band Pull-Apart","primary":"shoulders","secondary":["upper_back","traps"],"equipment":"band","category":"isolation","movement":"pull","tracking":"reps_only","rest":90},
  {"id":"barbell-shrug","name":"Shrug (Barbell)","primary":"traps","secondary":["forearms"],"equipment":"barbell","category":"isolation","movement":"pull","tracking":"weight_reps","rest":90},
  {"id":"dumbbell-shrug","name":"Shrug (Dumbbell)","primary":"traps","secondary":["forearms"],"equipment":"dumbbell","category":"isolation","movement":"pull","tracking":"weight_reps","rest":90},
  {"id":"upright-row","name":"Upright Row (Barbell)","primary":"traps","secondary":["shoulders","biceps"],"equipment":"barbell","category":"compound","movement":"pull","tracking":"weight_reps","rest":120},
  {"id":"farmers-walk","name":"Farmer's Walk (Dumbbell)","primary":"forearms","secondary":["traps","abs"],"equipment":"dumbbell","category":"compound","movement":"pull","tracking":"weight_distance","rest":120},
  {"id":"overhead-press","name":"Overhead Press (Barbell)","primary":"shoulders","secondary":["triceps","traps","abs"],"equipment":"barbell","category":"compound","movement":"push","tracking":"weight_reps","rest":180},
  {"id":"seated-dumbbell-press","name":"Seated Shoulder Press (Dumbbell)","primary":"shoulders","secondary":["triceps"],"equipment":"dumbbell","category":"compound","movement":"push","tracking":"weight_reps","rest":120},
  {"id":"arnold-press","name":"Arnold Press (Dumbbell)","primary":"shoulders","secondary":["triceps"],"equipment":"dumbbell","category":"compound","movement":"push","tracking":"weight_reps","rest":120},
  {"id":"machine-shoulder-press","name":"Shoulder Press (Machine)","primary":"shoulders","secondary":["triceps"],"equipment":"machine","category":"compound","movement":"push","tracking":"weight_reps","rest":120},
  {"id":"push-press","name":"Push Press (Barbell)","primary":"shoulders","secondary":["triceps","quads","glutes"],"equipment":"barbell","category":"compound","movement":"push","tracking":"weight_reps","rest":180},
  {"id":"landmine-press","name":"Landmine Press","primary":"shoulders","secondary":["chest","triceps"],"equipment":"barbell","category":"compound","movement":"push","tracking":"weight_reps","rest":120,"bar":"landmine"},
  {"id":"pike-push-up","name":"Pike Push-Up","primary":"shoulders","secondary":["triceps","chest"],"equipment":"bodyweight","category":"compound","movement":"push","tracking":"bodyweight_reps","rest":120},
  {"id":"lateral-raise","name":"Lateral Raise (Dumbbell)","primary":"shoulders","secondary":["traps"],"equipment":"dumbbell","category":"isolation","movement":"push","tracking":"weight_reps","rest":90},
  {"id":"cable-lateral-raise","name":"Lateral Raise (Cable)","primary":"shoulders","secondary":["traps"],"equipment":"cable","category":"isolation","movement":"push","tracking":"weight_reps","rest":90},
  {"id":"machine-lateral-raise","name":"Lateral Raise (Machine)","primary":"shoulders","secondary":[],"equipment":"machine","category":"isolation","movement":"push","tracking":"weight_reps","rest":90},
  {"id":"front-raise","name":"Front Raise (Dumbbell)","primary":"shoulders","secondary":["chest"],"equipment":"dumbbell","category":"isolation","movement":"push","tracking":"weight_reps","rest":90},
  {"id":"rear-delt-fly","name":"Rear Delt Fly (Dumbbell)","primary":"shoulders","secondary":["upper_back","traps"],"equipment":"dumbbell","category":"isolation","movement":"pull","tracking":"weight_reps","rest":90},
  {"id":"cable-rear-delt-fly","name":"Rear Delt Fly (Cable)","primary":"shoulders","secondary":["upper_back","traps"],"equipment":"cable","category":"isolation","movement":"pull","tracking":"weight_reps","rest":90},
  {"id":"reverse-pec-deck","name":"Reverse Fly (Machine)","primary":"shoulders","secondary":["upper_back","traps"],"equipment":"machine","category":"isolation","movement":"pull","tracking":"weight_reps","rest":90},
  {"id":"barbell-curl","name":"Bicep Curl (Barbell)","primary":"biceps","secondary":["forearms"],"equipment":"barbell","category":"isolation","movement":"pull","tracking":"weight_reps","rest":90},
  {"id":"ez-bar-curl","name":"Bicep Curl (EZ Bar)","primary":"biceps","secondary":["forearms"],"equipment":"barbell","category":"isolation","movement":"pull","tracking":"weight_reps","rest":90,"bar":"ez"},
  {"id":"dumbbell-curl","name":"Bicep Curl (Dumbbell)","primary":"biceps","secondary":["forearms"],"equipment":"dumbbell","category":"isolation","movement":"pull","tracking":"weight_reps","rest":90},
  {"id":"hammer-curl","name":"Hammer Curl (Dumbbell)","primary":"biceps","secondary":["forearms"],"equipment":"dumbbell","category":"isolation","movement":"pull","tracking":"weight_reps","rest":90},
  {"id":"incline-dumbbell-curl","name":"Incline Curl (Dumbbell)","primary":"biceps","secondary":["forearms"],"equipment":"dumbbell","category":"isolation","movement":"pull","tracking":"weight_reps","rest":90},
  {"id":"preacher-curl","name":"Preacher Curl (EZ Bar)","primary":"biceps","secondary":["forearms"],"equipment":"barbell","category":"isolation","movement":"pull","tracking":"weight_reps","rest":90,"bar":"ez"},
  {"id":"cable-curl","name":"Bicep Curl (Cable)","primary":"biceps","secondary":["forearms"],"equipment":"cable","category":"isolation","movement":"pull","tracking":"weight_reps","rest":90},
  {"id":"cable-hammer-curl","name":"Hammer Curl (Cable Rope)","primary":"biceps","secondary":["forearms"],"equipment":"cable","category":"isolation","movement":"pull","tracking":"weight_reps","rest":90},
  {"id":"concentration-curl","name":"Concentration Curl (Dumbbell)","primary":"biceps","secondary":[],"equipment":"dumbbell","category":"isolation","movement":"pull","tracking":"weight_reps","rest":90},
  {"id":"triceps-pushdown","name":"Triceps Pushdown (Cable)","primary":"triceps","secondary":[],"equipment":"cable","category":"isolation","movement":"push","tracking":"weight_reps","rest":90},
  {"id":"overhead-cable-extension","name":"Overhead Triceps Extension (Cable)","primary":"triceps","secondary":[],"equipment":"cable","category":"isolation","movement":"push","tracking":"weight_reps","rest":90},
  {"id":"skull-crusher","name":"Skull Crusher (EZ Bar)","primary":"triceps","secondary":[],"equipment":"barbell","category":"isolation","movement":"push","tracking":"weight_reps","rest":90,"bar":"ez"},
  {"id":"overhead-dumbbell-extension","name":"Overhead Triceps Extension (Dumbbell)","primary":"triceps","secondary":[],"equipment":"dumbbell","category":"isolation","movement":"push","tracking":"weight_reps","rest":90},
  {"id":"triceps-kickback","name":"Triceps Kickback (Dumbbell)","primary":"triceps","secondary":[],"equipment":"dumbbell","category":"isolation","movement":"push","tracking":"weight_reps","rest":90},
  {"id":"machine-triceps-extension","name":"Triceps Extension (Machine)","primary":"triceps","secondary":[],"equipment":"machine","category":"isolation","movement":"push","tracking":"weight_reps","rest":90},
  {"id":"bench-dip","name":"Bench Dip","primary":"triceps","secondary":["chest","shoulders"],"equipment":"bodyweight","category":"compound","movement":"push","tracking":"bodyweight_reps","rest":120},
  {"id":"assisted-dip","name":"Assisted Dip (Machine)","primary":"triceps","secondary":["chest","shoulders"],"equipment":"machine","category":"compound","movement":"push","tracking":"assisted_bodyweight","rest":120,"bwVolume":true},
  {"id":"diamond-push-up","name":"Diamond Push-Up","primary":"triceps","secondary":["chest","shoulders"],"equipment":"bodyweight","category":"compound","movement":"push","tracking":"bodyweight_reps","rest":120},
  {"id":"wrist-curl","name":"Wrist Curl (Dumbbell)","primary":"forearms","secondary":[],"equipment":"dumbbell","category":"isolation","movement":"pull","tracking":"weight_reps","rest":90},
  {"id":"reverse-curl","name":"Reverse Curl (Barbell)","primary":"forearms","secondary":["biceps"],"equipment":"barbell","category":"isolation","movement":"pull","tracking":"weight_reps","rest":90},
  {"id":"dead-hang","name":"Dead Hang","primary":"forearms","secondary":["lats","shoulders"],"equipment":"bodyweight","category":"isolation","movement":"pull","tracking":"duration","rest":90},
  {"id":"back-squat","name":"Squat (Barbell)","primary":"quads","secondary":["glutes","hamstrings","lower_back","abs"],"equipment":"barbell","category":"compound","movement":"legs","tracking":"weight_reps","rest":180},
  {"id":"front-squat","name":"Front Squat (Barbell)","primary":"quads","secondary":["glutes","abs","lower_back"],"equipment":"barbell","category":"compound","movement":"legs","tracking":"weight_reps","rest":180},
  {"id":"goblet-squat","name":"Goblet Squat (Dumbbell)","primary":"quads","secondary":["glutes","abs"],"equipment":"dumbbell","category":"compound","movement":"legs","tracking":"weight_reps","rest":120},
  {"id":"smith-squat","name":"Squat (Smith Machine)","primary":"quads","secondary":["glutes","hamstrings"],"equipment":"smith_machine","category":"compound","movement":"legs","tracking":"weight_reps","rest":120},
  {"id":"hack-squat","name":"Hack Squat (Machine)","primary":"quads","secondary":["glutes"],"equipment":"machine","category":"compound","movement":"legs","tracking":"weight_reps","rest":120},
  {"id":"leg-press","name":"Leg Press (Machine)","primary":"quads","secondary":["glutes","hamstrings"],"equipment":"machine","category":"compound","movement":"legs","tracking":"weight_reps","rest":120},
  {"id":"bodyweight-squat","name":"Air Squat","primary":"quads","secondary":["glutes"],"equipment":"bodyweight","category":"compound","movement":"legs","tracking":"bodyweight_reps","rest":120},
  {"id":"bulgarian-split-squat","name":"Bulgarian Split Squat (Dumbbell)","primary":"quads","secondary":["glutes","hamstrings"],"equipment":"dumbbell","category":"compound","movement":"legs","tracking":"weight_reps","rest":120},
  {"id":"walking-lunge","name":"Walking Lunge (Dumbbell)","primary":"quads","secondary":["glutes","hamstrings"],"equipment":"dumbbell","category":"compound","movement":"legs","tracking":"weight_reps","rest":120},
  {"id":"reverse-lunge","name":"Reverse Lunge (Barbell)","primary":"quads","secondary":["glutes","hamstrings"],"equipment":"barbell","category":"compound","movement":"legs","tracking":"weight_reps","rest":120},
  {"id":"step-up","name":"Step-Up (Dumbbell)","primary":"quads","secondary":["glutes"],"equipment":"dumbbell","category":"compound","movement":"legs","tracking":"weight_reps","rest":120},
  {"id":"leg-extension","name":"Leg Extension (Machine)","primary":"quads","secondary":[],"equipment":"machine","category":"isolation","movement":"legs","tracking":"weight_reps","rest":90},
  {"id":"hip-adduction","name":"Hip Adduction (Machine)","primary":"adductors","secondary":[],"equipment":"machine","category":"isolation","movement":"legs","tracking":"weight_reps","rest":90},
  {"id":"hip-abduction","name":"Hip Abduction (Machine)","primary":"abductors","secondary":["glutes"],"equipment":"machine","category":"isolation","movement":"legs","tracking":"weight_reps","rest":90},
  {"id":"romanian-deadlift","name":"Romanian Deadlift (Barbell)","primary":"hamstrings","secondary":["glutes","lower_back","forearms"],"equipment":"barbell","category":"compound","movement":"legs","tracking":"weight_reps","rest":180},
  {"id":"dumbbell-romanian-deadlift","name":"Romanian Deadlift (Dumbbell)","primary":"hamstrings","secondary":["glutes","lower_back"],"equipment":"dumbbell","category":"compound","movement":"legs","tracking":"weight_reps","rest":120},
  {"id":"single-leg-rdl","name":"Single-Leg Romanian Deadlift (Dumbbell)","primary":"hamstrings","secondary":["glutes","lower_back"],"equipment":"dumbbell","category":"compound","movement":"legs","tracking":"weight_reps","rest":120},
  {"id":"lying-leg-curl","name":"Lying Leg Curl (Machine)","primary":"hamstrings","secondary":["calves"],"equipment":"machine","category":"isolation","movement":"legs","tracking":"weight_reps","rest":90},
  {"id":"seated-leg-curl","name":"Seated Leg Curl (Machine)","primary":"hamstrings","secondary":[],"equipment":"machine","category":"isolation","movement":"legs","tracking":"weight_reps","rest":90},
  {"id":"nordic-curl","name":"Nordic Hamstring Curl","primary":"hamstrings","secondary":["glutes"],"equipment":"bodyweight","category":"isolation","movement":"legs","tracking":"bodyweight_reps","rest":90},
  {"id":"hip-thrust","name":"Hip Thrust (Barbell)","primary":"glutes","secondary":["hamstrings","quads"],"equipment":"barbell","category":"compound","movement":"legs","tracking":"weight_reps","rest":180},
  {"id":"glute-bridge","name":"Glute Bridge","primary":"glutes","secondary":["hamstrings"],"equipment":"bodyweight","category":"isolation","movement":"legs","tracking":"bodyweight_reps","rest":90},
  {"id":"cable-kickback","name":"Glute Kickback (Cable)","primary":"glutes","secondary":["hamstrings"],"equipment":"cable","category":"isolation","movement":"legs","tracking":"weight_reps","rest":90},
  {"id":"kettlebell-swing","name":"Kettlebell Swing","primary":"glutes","secondary":["hamstrings","lower_back","shoulders"],"equipment":"kettlebell","category":"compound","movement":"legs","tracking":"weight_reps","rest":120},
  {"id":"standing-calf-raise","name":"Standing Calf Raise (Machine)","primary":"calves","secondary":[],"equipment":"machine","category":"isolation","movement":"legs","tracking":"weight_reps","rest":90},
  {"id":"seated-calf-raise","name":"Seated Calf Raise (Machine)","primary":"calves","secondary":[],"equipment":"machine","category":"isolation","movement":"legs","tracking":"weight_reps","rest":90},
  {"id":"dumbbell-calf-raise","name":"Single-Leg Calf Raise (Dumbbell)","primary":"calves","secondary":[],"equipment":"dumbbell","category":"isolation","movement":"legs","tracking":"weight_reps","rest":90},
  {"id":"plank","name":"Plank","primary":"abs","secondary":["shoulders","lower_back"],"equipment":"bodyweight","category":"isolation","movement":"core","tracking":"duration","rest":60},
  {"id":"side-plank","name":"Side Plank","primary":"abs","secondary":["glutes"],"equipment":"bodyweight","category":"isolation","movement":"core","tracking":"duration","rest":60},
  {"id":"crunch","name":"Crunch","primary":"abs","secondary":[],"equipment":"bodyweight","category":"isolation","movement":"core","tracking":"bodyweight_reps","rest":60},
  {"id":"hanging-leg-raise","name":"Hanging Leg Raise","primary":"abs","secondary":["forearms"],"equipment":"bodyweight","category":"isolation","movement":"core","tracking":"bodyweight_reps","rest":60},
  {"id":"hanging-knee-raise","name":"Hanging Knee Raise","primary":"abs","secondary":["forearms"],"equipment":"bodyweight","category":"isolation","movement":"core","tracking":"bodyweight_reps","rest":60},
  {"id":"cable-crunch","name":"Cable Crunch","primary":"abs","secondary":[],"equipment":"cable","category":"isolation","movement":"core","tracking":"weight_reps","rest":60},
  {"id":"machine-crunch","name":"Ab Crunch (Machine)","primary":"abs","secondary":[],"equipment":"machine","category":"isolation","movement":"core","tracking":"weight_reps","rest":60},
  {"id":"ab-wheel-rollout","name":"Ab Wheel Rollout","primary":"abs","secondary":["lats","lower_back"],"equipment":"bodyweight","category":"compound","movement":"core","tracking":"bodyweight_reps","rest":60},
  {"id":"russian-twist","name":"Russian Twist","primary":"abs","secondary":[],"equipment":"bodyweight","category":"isolation","movement":"core","tracking":"bodyweight_reps","rest":60},
  {"id":"dead-bug","name":"Dead Bug","primary":"abs","secondary":[],"equipment":"bodyweight","category":"isolation","movement":"core","tracking":"bodyweight_reps","rest":60},
  {"id":"pallof-press","name":"Pallof Press (Cable)","primary":"abs","secondary":["shoulders"],"equipment":"cable","category":"isolation","movement":"core","tracking":"weight_reps","rest":60},
  {"id":"mountain-climber","name":"Mountain Climber","primary":"abs","secondary":["shoulders"],"equipment":"bodyweight","category":"compound","movement":"core","tracking":"duration","rest":60},
  {"id":"power-clean","name":"Power Clean (Barbell)","primary":"full_body","secondary":["traps","quads","glutes","hamstrings","shoulders"],"equipment":"barbell","category":"compound","movement":"pull","tracking":"weight_reps","rest":180},
  {"id":"burpee","name":"Burpee","primary":"full_body","secondary":["chest","quads"],"equipment":"bodyweight","category":"compound","movement":"cardio","tracking":"bodyweight_reps","rest":60},
  {"id":"treadmill","name":"Running (Treadmill)","primary":"cardio","secondary":["quads","calves"],"equipment":"machine","category":"cardio","movement":"cardio","tracking":"distance_duration","rest":0},
  {"id":"stationary-bike","name":"Cycling (Stationary Bike)","primary":"cardio","secondary":["quads"],"equipment":"machine","category":"cardio","movement":"cardio","tracking":"distance_duration","rest":0},
  {"id":"air-bike","name":"Air Bike","primary":"cardio","secondary":["quads","shoulders"],"equipment":"machine","category":"cardio","movement":"cardio","tracking":"duration","rest":0},
  {"id":"rowing-machine","name":"Rowing (Machine)","primary":"cardio","secondary":["upper_back","quads","lats"],"equipment":"machine","category":"cardio","movement":"cardio","tracking":"distance_duration","rest":0},
  {"id":"elliptical","name":"Elliptical","primary":"cardio","secondary":["quads","glutes"],"equipment":"machine","category":"cardio","movement":"cardio","tracking":"distance_duration","rest":0},
  {"id":"stair-climber","name":"Stair Climber","primary":"cardio","secondary":["glutes","calves"],"equipment":"machine","category":"cardio","movement":"cardio","tracking":"duration","rest":0},
]

const BY_ID = new Map(EXERCISES.map((entry) => [entry.id, entry]))
const MUSCLE_LABEL = Object.fromEntries(MUSCLES.map((muscle) => [muscle.id, muscle.label]))
const EQUIPMENT_LABEL = Object.fromEntries(EQUIPMENT.map((item) => [item.id, item.label]))

const isEntry = (value) => Boolean(value) && typeof value === 'object' && typeof value.id === 'string' && value.id !== ''
const customList = (customExercises) => (Array.isArray(customExercises) ? customExercises.filter(isEntry) : [])

// Built-in or custom (hidden customs included, so history still resolves), else null.
export function exerciseById(id, customExercises = []) {
  if (typeof id !== 'string' || !id) return null
  return BY_ID.get(id) || customList(customExercises).find((entry) => entry.id === id) || null
}

export function allExercises(customExercises = []) {
  return [...EXERCISES, ...customList(customExercises).filter((entry) => !entry.hidden && typeof entry.name === 'string')]
}

// Lower-case, accents and apostrophes removed, everything else non-alphanumeric becomes a space.
function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const searchIndex = new WeakMap()

function indexFor(entry) {
  let index = searchIndex.get(entry)
  if (!index) {
    const name = normalize(entry.name)
    const secondary = Array.isArray(entry.secondary) ? entry.secondary : []
    const primary = [entry.primary, own(MUSCLE_LABEL, entry.primary), entry.equipment, own(EQUIPMENT_LABEL, entry.equipment)].map(normalize).join(' ')
    index = {
      name,
      words: name.split(' '),
      compact: name.replace(/ /g, ''),
      primary,
      secondary: secondary.flatMap((muscle) => [muscle, own(MUSCLE_LABEL, muscle)]).map(normalize).join(' '),
    }
    searchIndex.set(entry, index)
  }
  return index
}

const byName = (a, b) => String(a.name).localeCompare(String(b.name))

// Case-insensitive; every query token must match the name, a muscle or the equipment. Ranking:
// name starts with the query, then every token starts a word of the name, then all tokens in the
// name, then name/primary muscle/equipment, then matches that need a secondary muscle.
export function searchExercises(query, options = {}) {
  const { muscle, equipment, customExercises } = options || {}
  let pool = allExercises(customExercises)
  if (muscle) pool = pool.filter((entry) => entry.primary === muscle || (Array.isArray(entry.secondary) && entry.secondary.includes(muscle)))
  if (equipment) pool = pool.filter((entry) => entry.equipment === equipment)
  const phrase = normalize(query)
  if (!phrase) return [...pool].sort(byName)
  const tokens = phrase.split(' ')
  const ranked = []
  for (const entry of pool) {
    const index = indexFor(entry)
    const inName = (token) => index.name.includes(token) || index.compact.includes(token)
    let rank
    if (index.name.startsWith(phrase) || index.compact.startsWith(phrase.replace(/ /g, ''))) rank = 0
    else if (tokens.every((token) => index.words.some((word) => word.startsWith(token)))) rank = 1
    else if (tokens.every(inName)) rank = 2
    else if (tokens.every((token) => inName(token) || index.primary.includes(token))) rank = 3
    else if (tokens.every((token) => inName(token) || index.primary.includes(token) || index.secondary.includes(token))) rank = 4
    else continue
    ranked.push({ entry, rank })
  }
  return ranked.sort((a, b) => a.rank - b.rank || byName(a.entry, b.entry)).map((item) => item.entry)
}

const DURATION_TYPES = new Set(['duration', 'weight_duration'])
const DISTANCE_TYPES = new Set(['distance_duration', 'weight_distance'])
const DEFAULT_REST = { compound: 120, isolation: 90, cardio: 0 }

function restFor(exercise) {
  const rest = exercise?.rest
  if (typeof rest === 'number' && Number.isFinite(rest)) return Math.min(600, Math.max(0, Math.round(rest)))
  return own(DEFAULT_REST, exercise?.category) ?? 120
}

function routineSet(tracking, { repsMin = 8, repsMax = 12, durationSec = 60 } = {}) {
  const set = { type: 'normal', weightKg: null, repsMin: null, repsMax: null, durationSec: null, distanceM: null, rpe: null }
  if (DURATION_TYPES.has(tracking)) set.durationSec = durationSec
  else if (!DISTANCE_TYPES.has(tracking)) Object.assign(set, { repsMin, repsMax })
  return set
}

function routineExercise(exercise, makeId, count, setOptions) {
  const tracking = own(TRACKING, exercise?.tracking) ? exercise.tracking : 'weight_reps'
  const sets = Number.isFinite(count) && count >= 1 ? Math.floor(count) : 3
  return {
    id: makeId(),
    exerciseId: exercise?.id ?? null,
    name: String(exercise?.name ?? 'Exercise'),
    tracking,
    restSec: restFor(exercise),
    note: '',
    supersetId: null,
    sets: Array.from({ length: sets }, () => routineSet(tracking, setOptions)),
  }
}

// RoutineExercise for a library/custom entry: rep range 8-12, 60 s for timed sets, distance left empty.
export function newRoutineExercise(exercise, makeId = defaultId, sets = 3) {
  return routineExercise(exercise, typeof makeId === 'function' ? makeId : defaultId, sets)
}

// ---- onboarding templates ------------------------------------------------------------------

export const TEMPLATES = [
  { id: 'ppl-r', name: 'Push / Pull / Legs / Rest', description: 'A 4-day rotation (Push, Pull, Legs, Rest) that repeats regardless of the weekday.' },
  { id: 'ppl2', name: 'Push / Pull / Legs ×2', description: 'Push, Pull, Legs twice a week, Monday to Saturday. Sunday is rest.' },
  { id: 'upper-lower', name: 'Upper / Lower', description: 'Upper Monday and Thursday, Lower Tuesday and Friday.' },
  { id: 'bro', name: 'Bro split', description: 'A 7-day rotation: Chest, Back, Shoulders, Legs, Arms, then two rest days.' },
  { id: 'full-body', name: 'Full Body', description: 'Three full-body workouts a week: Monday, Wednesday and Friday.' },
  { id: 'custom', name: 'Custom', description: 'Start empty and build your own routines and schedule.' },
]

// "<exercise id> <sets>x<reps>[-<reps>]" or "<exercise id> <sets>x<seconds>s".
const ROUTINE_PLANS = {
  push: { name: 'Push', color: 'red', exercises: ['bench-press 3x6-8', 'incline-dumbbell-press 3x8-10', 'seated-dumbbell-press 3x8-10', 'lateral-raise 3x12-15', 'triceps-pushdown 3x10-12', 'overhead-cable-extension 3x10-12'] },
  pull: { name: 'Pull', color: 'blue', exercises: ['barbell-row 3x6-8', 'lat-pulldown 3x8-10', 'seated-cable-row 3x10-12', 'face-pull 3x12-15', 'dumbbell-curl 3x10-12', 'hammer-curl 3x10-12'] },
  legs: { name: 'Legs', color: 'green', exercises: ['back-squat 3x6-8', 'romanian-deadlift 3x8-10', 'leg-press 3x10-12', 'lying-leg-curl 3x10-12', 'standing-calf-raise 4x10-15'] },
  shoulders: { name: 'Shoulders', color: 'amber', exercises: ['overhead-press 3x6-8', 'arnold-press 3x8-10', 'cable-lateral-raise 4x12-15', 'reverse-pec-deck 3x12-15', 'dumbbell-shrug 3x10-12'] },
  arms: { name: 'Arms', color: 'pink', exercises: ['ez-bar-curl 3x8-10', 'skull-crusher 3x8-10', 'incline-dumbbell-curl 3x10-12', 'triceps-pushdown 3x10-12', 'cable-hammer-curl 3x12-15'] },
  chest: { name: 'Chest', color: 'red', exercises: ['bench-press 4x6-8', 'incline-dumbbell-press 3x8-10', 'chest-press-machine 3x10-12', 'cable-crossover 3x12-15'] },
  back: { name: 'Back', color: 'blue', exercises: ['deadlift 3x5', 'pull-up 3x6-10', 'dumbbell-row 3x8-10', 'lat-pulldown 3x10-12', 'face-pull 3x12-15'] },
  upper: { name: 'Upper', color: 'indigo', exercises: ['bench-press 3x6-8', 'barbell-row 3x6-8', 'seated-dumbbell-press 3x8-10', 'lat-pulldown 3x8-10', 'dumbbell-curl 2x10-12', 'triceps-pushdown 2x10-12'] },
  lower: { name: 'Lower', color: 'teal', exercises: ['back-squat 3x6-8', 'romanian-deadlift 3x8-10', 'bulgarian-split-squat 3x8-10', 'leg-extension 3x12-15', 'standing-calf-raise 3x10-15'] },
  fullBody: { name: 'Full Body', color: 'orange', exercises: ['back-squat 3x5-8', 'bench-press 3x5-8', 'barbell-row 3x6-10', 'overhead-press 2x8-10', 'plank 3x60s'] },
}

// Rotation: `cycle` of plan keys (null = rest). Weekly: `weekly` indexed by weekday, 0 = Sunday.
const TEMPLATE_PLANS = {
  'ppl-r': { mode: 'rotation', cycle: ['push', 'pull', 'legs', null] },
  ppl2: { mode: 'weekly', weekly: [null, 'push', 'pull', 'legs', 'push', 'pull', 'legs'] },
  'upper-lower': { mode: 'weekly', weekly: [null, 'upper', 'lower', null, 'upper', 'lower', null] },
  bro: { mode: 'rotation', cycle: ['chest', 'back', 'shoulders', 'legs', 'arms', null, null] },
  'full-body': { mode: 'weekly', weekly: [null, 'fullBody', null, 'fullBody', null, 'fullBody', null] },
}

function planExercise(spec, makeId) {
  const [, id, sets, first, second, seconds] = spec.match(/^(\S+) (\d+)x(\d+)(?:-(\d+))?(s)?$/)
  const exercise = BY_ID.get(id)
  if (seconds) return routineExercise(exercise, makeId, Number(sets), { durationSec: Number(first) })
  return routineExercise(exercise, makeId, Number(sets), { repsMin: Number(first), repsMax: Number(second ?? first) })
}

// → { routines, schedule } with one version effective today (rotation anchor 0). Unknown ids
// behave like 'custom'.
export function buildTemplate(templateId, today, makeId = defaultId) {
  if (typeof makeId !== 'function') makeId = defaultId
  const template = own(TEMPLATE_PLANS, templateId)
  const base = emptySchedule()
  if (!template) return { routines: [], schedule: base }
  const stamp = nowIso()
  const routines = []
  const routineIds = {}
  const slotFor = (key) => {
    if (!key) return { kind: 'rest' }
    if (!routineIds[key]) {
      const plan = ROUTINE_PLANS[key]
      const routine = {
        id: makeId(),
        name: plan.name,
        color: plan.color,
        notes: '',
        folderId: null,
        exercises: plan.exercises.map((spec) => planExercise(spec, makeId)),
        createdAt: stamp,
        updatedAt: stamp,
      }
      routines.push(routine)
      routineIds[key] = routine.id
    }
    return { kind: 'routine', routineId: routineIds[key] }
  }
  const rotation = template.mode === 'rotation'
  const version = {
    id: `v${today}-${makeId()}`,
    effectiveFrom: today,
    mode: template.mode,
    cycle: rotation ? template.cycle.map(slotFor) : [],
    anchorIndex: 0,
    weekly: rotation ? [] : template.weekly.map(slotFor),
  }
  return { routines, schedule: { ...base, versions: [version] } }
}

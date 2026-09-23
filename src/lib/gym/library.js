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

// timed: a plan spec that gives seconds, which also sets a time target on distance + time cardio.
function routineSet(tracking, { repsMin = 8, repsMax = 12, durationSec = 60, timed = false } = {}) {
  const set = { type: 'normal', weightKg: null, repsMin: null, repsMax: null, durationSec: null, distanceM: null, rpe: null }
  if (DURATION_TYPES.has(tracking) || (timed && tracking === 'distance_duration')) set.durationSec = durationSec
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
  // Only used by custom split days (not by the onboarding templates).
  core: { name: 'Core', color: 'teal', exercises: ['hanging-leg-raise 3x10-15', 'cable-crunch 3x12-15', 'ab-wheel-rollout 3x8-12', 'pallof-press 3x10-12', 'plank 3x60s'] },
  glutes: { name: 'Glutes', color: 'pink', exercises: ['hip-thrust 4x8-10', 'romanian-deadlift 3x8-10', 'bulgarian-split-squat 3x8-10', 'cable-kickback 3x12-15', 'hip-abduction 3x12-15'] },
  cardio: { name: 'Cardio', color: 'orange', exercises: ['treadmill 1x1200s', 'rowing-machine 1x600s', 'stair-climber 1x600s'] },
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
  if (seconds) return routineExercise(exercise, makeId, Number(sets), { durationSec: Number(first), timed: true })
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

// ---- custom splits: day types, suggested exercises per day, free-text parsing -----------------

const MAX_SPLIT_DAYS = 31
const MAX_DAY_EXERCISES = 8
const MAX_DAY_NAME = 40
const MAX_SPLIT_TEXT = 600

// The split wizard's palette. Colours are ROUTINE_COLORS ids; Rest has none.
export const DAY_TYPES = [
  { id: 'push', name: 'Push', color: 'red', hint: 'Chest, shoulders, triceps' },
  { id: 'pull', name: 'Pull', color: 'blue', hint: 'Back, biceps, rear delts' },
  { id: 'legs', name: 'Legs', color: 'green', hint: 'Quads, hamstrings, calves' },
  { id: 'upper', name: 'Upper', color: 'indigo', hint: 'Chest, back, shoulders, arms' },
  { id: 'lower', name: 'Lower', color: 'teal', hint: 'Quads, hamstrings, glutes' },
  { id: 'chest', name: 'Chest', color: 'red', hint: 'Presses and flyes' },
  { id: 'back', name: 'Back', color: 'blue', hint: 'Rows, pulldowns, deadlifts' },
  { id: 'shoulders', name: 'Shoulders', color: 'amber', hint: 'Presses, raises, rear delts' },
  { id: 'arms', name: 'Arms', color: 'pink', hint: 'Biceps and triceps' },
  { id: 'fullBody', name: 'Full Body', color: 'orange', hint: 'Squat, press, row' },
  { id: 'core', name: 'Core', color: 'teal', hint: 'Abs and obliques' },
  { id: 'glutes', name: 'Glutes', color: 'pink', hint: 'Hip thrusts, hinges, lunges' },
  { id: 'cardio', name: 'Cardio', color: 'orange', hint: 'Run, row, climb' },
  { id: 'rest', name: 'Rest', color: null, hint: 'Recover', rest: true },
]
const DAY_TYPE_BY_ID = new Map(DAY_TYPES.map((type) => [type.id, type]))

// Words for a training day → [day type, label when it isn't the type's name, accessory]. An
// accessory is a muscle usually trained alongside a main day, so "back biceps" is one day.
const DAY_WORDS = {
  push: ['push'], pushing: ['push'],
  pull: ['pull'], pulling: ['pull'],
  legs: ['legs'], leg: ['legs'], quads: ['legs', 'Quads'], quad: ['legs', 'Quads'],
  hamstrings: ['legs', 'Hamstrings'], hamstring: ['legs', 'Hamstrings'], hams: ['legs', 'Hamstrings'],
  calves: ['legs', 'Calves', true], calf: ['legs', 'Calves', true],
  upper: ['upper'], lower: ['lower'],
  chest: ['chest'], pecs: ['chest'], pec: ['chest'],
  back: ['back'], lats: ['back'], traps: ['back', 'Traps', true],
  shoulders: ['shoulders'], shoulder: ['shoulders'], delts: ['shoulders'], delt: ['shoulders'],
  arms: ['arms'], arm: ['arms'], guns: ['arms'],
  biceps: ['arms', 'Biceps', true], bicep: ['arms', 'Biceps', true], bis: ['arms', 'Biceps', true], bi: ['arms', 'Biceps', true],
  triceps: ['arms', 'Triceps', true], tricep: ['arms', 'Triceps', true], tris: ['arms', 'Triceps', true], tri: ['arms', 'Triceps', true],
  forearms: ['arms', 'Forearms', true], forearm: ['arms', 'Forearms', true],
  fullbody: ['fullBody'], full: ['fullBody'], fb: ['fullBody'], fbw: ['fullBody'],
  core: ['core'], abs: ['core', 'Abs', true], ab: ['core', 'Abs', true], abdominals: ['core', 'Abs', true], obliques: ['core', 'Abs', true],
  glutes: ['glutes'], glute: ['glutes'], booty: ['glutes'], bum: ['glutes'], butt: ['glutes'],
  cardio: ['cardio'], conditioning: ['cardio', 'Conditioning'], hiit: ['cardio', 'HIIT'], run: ['cardio', 'Run'], running: ['cardio', 'Running'],
  jog: ['cardio', 'Jog'], jogging: ['cardio', 'Jogging'], bike: ['cardio', 'Bike'], cycling: ['cardio', 'Cycling'], spin: ['cardio', 'Spin'],
  swim: ['cardio', 'Swim'], swimming: ['cardio', 'Swimming'], walk: ['cardio', 'Walk'], walking: ['cardio', 'Walking'],
  rest: ['rest'], resting: ['rest'], off: ['rest'], recovery: ['rest'], recover: ['rest'], break: ['rest'], none: ['rest'], nothing: ['rest'],
}
const FUZZY_WORDS = Object.keys(DAY_WORDS).filter((word) => word.length >= 5)

const SPLIT_ABBREVIATIONS = {
  ppl: ['push', 'pull', 'legs'],
  pplr: ['push', 'pull', 'legs', 'rest'],
  ul: ['upper', 'lower'],
  ulr: ['upper', 'lower', 'rest'],
  bro: ['chest', 'back', 'shoulders', 'legs', 'arms'],
}

const FILLER_WORDS = new Set([
  'day', 'days', 'workout', 'workouts', 'session', 'sessions', 'training', 'train', 'focus', 'focused', 'split', 'routine',
  'routines', 'program', 'the', 'my', 'of', 'only', 'time', 'week', 'weekly', 'every', 'each', 'cycle', 'rotation', 'repeat',
  'is', 'on', 'for', 'body', 'mon', 'monday', 'tue', 'tues', 'tuesday', 'wed', 'weds', 'wednesday', 'thu', 'thur', 'thurs',
  'thursday', 'fri', 'friday', 'sat', 'saturday', 'sun', 'sunday',
])
// Words that describe the day that follows them: "heavy legs", "active recovery".
const DAY_MODIFIERS = new Set([
  'heavy', 'light', 'power', 'strength', 'hypertrophy', 'volume', 'pump', 'easy', 'hard', 'intense', 'deload', 'home', 'gym',
  'active', 'max', 'speed', 'explosive', 'long', 'short', 'big', 'accessory',
])
const JOIN_WORDS = new Set(['&', 'with', 'plus', 'n'])

// Extra exercises for a second focus in a day's name ("legs & abs", "back & biceps").
const ACCESSORY_PLANS = {
  abs: ['hanging-leg-raise 3x10-15', 'cable-crunch 3x12-15'],
  core: ['hanging-leg-raise 3x10-15', 'cable-crunch 3x12-15'],
  biceps: ['dumbbell-curl 3x10-12', 'hammer-curl 3x10-12'],
  triceps: ['triceps-pushdown 3x10-12', 'overhead-cable-extension 3x10-12'],
  arms: ['dumbbell-curl 3x10-12', 'triceps-pushdown 3x10-12'],
  forearms: ['wrist-curl 3x12-15', 'reverse-curl 3x10-12'],
  calves: ['standing-calf-raise 4x10-15', 'seated-calf-raise 3x12-15'],
  traps: ['dumbbell-shrug 3x10-12'],
  shoulders: ['lateral-raise 3x12-15', 'rear-delt-fly 3x12-15'],
  chest: ['incline-dumbbell-press 3x8-10', 'cable-crossover 3x12-15'],
  back: ['lat-pulldown 3x8-10', 'seated-cable-row 3x10-12'],
  legs: ['leg-press 3x10-12', 'lying-leg-curl 3x10-12'],
  glutes: ['hip-thrust 3x8-10', 'cable-kickback 3x12-15'],
  cardio: ['stationary-bike 1x900s'],
}

// Optimal string alignment distance <= 1 (one insert, delete, substitution or swap).
function withinOneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false
  const prev2 = []
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], prev2[j - 2] + 1)
    }
    prev2.splice(0, prev2.length, ...prev)
    prev = row
  }
  return prev[b.length] <= 1
}

// { type, label, accessory } for a word that names a training day (typos of longer words and a
// glued "day" allowed: "sholders", "legday"), else null.
function dayWord(word) {
  let entry = own(DAY_WORDS, word)
  if (!entry && word.length > 3 && word.endsWith('s')) entry = own(DAY_WORDS, word.slice(0, -1))
  if (!entry && word.length > 4 && word.endsWith('day')) entry = own(DAY_WORDS, word.slice(0, -3))
  if (!entry && word.length >= 5) {
    const key = FUZZY_WORDS.find((candidate) => withinOneEdit(word, candidate))
    if (key) entry = DAY_WORDS[key]
  }
  if (!entry) return null
  const [type, label, accessory] = entry
  return { type, label: label || DAY_TYPE_BY_ID.get(type).name, accessory: accessory === true }
}

const typeWord = (type) => ({ type, label: DAY_TYPE_BY_ID.get(type).name, accessory: false })
const titleWord = (word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : '')

// Lower-case text → segments (split on commas, slashes, arrows, "then" …) of words.
function splitSegments(text) {
  const clean = String(text ?? '')
    .slice(0, MAX_SPLIT_TEXT)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // accents
    .replace(/['’`]/g, '')
    .replace(/\bw\//g, ' with ')
    .replace(/[×✕✖]/g, 'x')
    .replace(/\*\s*(\d)/g, 'x$1')
    .replace(/->|=>|→|⟶|➜|➔|»|>/g, ',')
    .replace(/\b(?:and then|then|followed by|after that)\b/g, ',')
    .replace(/[,;/\\|+.·•–—:\n\r\t]/g, ',')
    .replace(/[-_]/g, ' ')
    .replace(/&/g, ' & ')
    .replace(/\b(?:full|total|whole)\s*body\b/g, ' fullbody ')
    .replace(/\b(upper|lower)\s*body\b/g, ' $1 ')
    .replace(/\b([a-z]{2,})x(\d{1,2})\b/g, '$1 x$2') // "pplx2"
    .replace(/\b(\d{1,2})x([a-z]{2,})\b/g, '$1x $2') // "2xppl"
    .replace(/\bx\s+(\d{1,2})\b/g, ' x$1 ')
    .replace(/\b(\d{1,2})\s+x\b/g, ' $1x ')
    .replace(/[^a-z0-9&,\s]/g, ' ')
    .replace(/\b([a-z]{2,})(\d{1,2})\b/g, '$1 #$2') // "push1": '#1' is always a label, never a count
  return clean.split(',').map((segment) => segment.split(/\s+/).filter(Boolean)).filter((words) => words.length)
}

function repeatToken(word) {
  let match = /^x(\d{1,2})$/.exec(word)
  if (match) return { n: Number(match[1]), prefix: false }
  match = /^(\d{1,2})x$/.exec(word)
  if (match) return { n: Number(match[1]), prefix: true }
  if (word === 'twice') return { n: 2, prefix: false }
  if (word === 'thrice') return { n: 3, prefix: false }
  return null
}

const clampCount = (n) => Math.min(10, Math.max(1, Math.trunc(n) || 1))
const accessoryKey = (info) => (own(ACCESSORY_PLANS, info.label.toLowerCase()) ? info.label.toLowerCase() : info.type)

function newGroup(info, mods, count) {
  return { type: info ? info.type : null, label: info ? info.label : '', custom: info ? null : [], mods, suffix: [], joins: [], extras: [], count }
}

const isNumberWord = (word) => /^\d{1,2}$/.test(word)
// "day 1 push", "week 2: upper lower": a number right after these words numbers the list.
const INDEX_WORDS = new Set(['day', 'week'])

// One segment's words → day groups (repeats already applied, `count` expanded later).
// state.labels: a number has been read as a label ("push 1") somewhere in the text, so later
// numbers after a day are labels too ("push 1 pull 1 push 2 pull 2"), not counts.
function parseSegment(words, state = { labels: false }) {
  const groups = []
  let blockStart = 0 // groups from here repeat on the next "x2"
  let blockRepeat = 1 // a leading "2x" repeats the block after it
  let mods = []
  let join = null // 'join' after & / with / plus, 'and' after "and"
  let count = 1 // "2 rest" → two rest days
  let attachable = false // the previous word belonged to the last group
  let lastUnknown = false
  const current = () => (groups.length > blockStart ? groups[groups.length - 1] : null)
  const closeBlock = (n) => {
    const block = groups.slice(blockStart)
    for (let i = 1; i < n && groups.length < MAX_SPLIT_DAYS * 2; i++) groups.push(...block)
    blockStart = groups.length
    blockRepeat = 1
  }
  const reset = (canAttach, unknown) => {
    mods = []
    join = null
    count = 1
    attachable = canAttach
    lastUnknown = unknown
  }

  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const repeat = repeatToken(word)
    if (repeat) {
      if (current()) closeBlock(clampCount(repeat.n))
      else blockRepeat = clampCount(repeat.n)
      reset(false, false)
      continue
    }
    const numbered = /^#\d{1,2}$/.test(word) ? word.slice(1) : isNumberWord(word) ? word : null
    if (numbered !== null) {
      if (INDEX_WORDS.has(words[i - 1])) continue // "day 1 push", "day2 pull": an index, not a label or count
      const label = current() && attachable
      const next = words[i + 1]
      // A bare number before a day repeats it ("2 rest"), unless it reads as a label: "push 1 pull",
      // or any number after a day once one was a label. '#1' (from "push1") is always a label.
      if (word === numbered && !(label && (numbered === '1' || state.labels)) && next && (dayWord(next) || own(SPLIT_ABBREVIATIONS, next))) {
        count = clampCount(Number(numbered))
      } else if (label) {
        current().suffix.push(numbered) // "push 1"
        state.labels = true
      }
      continue
    }
    if (JOIN_WORDS.has(word)) {
      join = 'join'
      continue
    }
    if (word === 'and') {
      join = join || 'and'
      continue
    }
    if (FILLER_WORDS.has(word)) {
      lastUnknown = false
      continue
    }
    if (/^[a-d]$/.test(word)) {
      if (current() && attachable) current().suffix.push(word.toUpperCase()) // "upper a"; else an article
      continue
    }
    const abbreviation = own(SPLIT_ABBREVIATIONS, word)
    if (abbreviation) {
      for (let r = 0; r < count; r++) for (const type of abbreviation) groups.push(newGroup(typeWord(type), mods, 1))
      reset(false, false)
      continue
    }
    const info = DAY_MODIFIERS.has(word) ? null : dayWord(word)
    if (!info && DAY_MODIFIERS.has(word)) {
      mods.push(word)
      attachable = false
      continue
    }
    const last = current()
    if (info) {
      const attach = last && last.type !== 'rest' && info.type !== 'rest' && !mods.length && count === 1
        && (join === 'join' || (info.accessory && (join === 'and' || attachable)))
      if (attach) {
        last.joins.push(info.label)
        last.extras.push(accessoryKey(info))
      } else {
        groups.push(newGroup(info, mods, count))
      }
      reset(true, false)
      continue
    }
    // Unknown words: consecutive ones make one custom name ("hot yoga").
    if (last && join === 'join') {
      last.joins.push(titleWord(word))
    } else if (last && lastUnknown && last.custom && !mods.length && count === 1) {
      last.custom.push(word)
    } else {
      const group = newGroup(null, mods, count)
      group.custom.push(word)
      groups.push(group)
    }
    reset(true, true)
  }
  if (mods.length && current()) current().suffix.push(...mods)
  if (blockRepeat > 1 && current()) closeBlock(blockRepeat)
  return groups
}

function groupName(group) {
  if (group.type === 'rest') return 'Rest'
  const main = group.custom ? group.custom.map(titleWord).join(' ') : group.label
  const suffix = group.suffix.map((part) => (/^[a-d]$/i.test(part) ? part.toUpperCase() : titleWord(part)))
  const name = [...group.mods.map(titleWord), main, ...suffix].join(' ') + group.joins.map((part) => ` & ${part}`).join('')
  return name.slice(0, MAX_DAY_NAME).trim()
}

function firstGroup(name) {
  for (const words of splitSegments(name)) {
    const groups = parseSegment(words)
    if (groups.length) return groups[0]
  }
  return null
}

// Free text → day names in order, e.g. 'push pull shoulders legs rest rest', 'PPL x2 + rest',
// 'upper/lower/rest', 'chest & triceps, back & biceps, legs, off'. Known days get their usual
// name ('shoulder day' → 'Shoulders', 'day off' → 'Rest'); anything else keeps its words as a
// custom name. 'x2' repeats what came before it in the same part, '2 rest' repeats one day.
// A numbered list ('1. push 2. pull', '1) push 2) pull', 'day 1 push, day 2 pull') is read
// without its numbers; 'push 1 pull 1 push 2 pull 2' keeps them as labels. At most 31 days.
export function parseSplit(text) {
  if (typeof text !== 'string' || !text.trim()) return []
  let segments = splitSegments(text)
  // Numbers 1, 2, 3 … in order, starting the text: list numbers, dropped before reading the days.
  const numbers = segments.flat().filter(isNumberWord)
  if (numbers.length >= 2 && segments[0][0] === '1' && numbers.every((word, i) => Number(word) === i + 1)) {
    segments = segments.map((words) => words.filter((word) => !isNumberWord(word))).filter((words) => words.length)
  }
  const state = { labels: false }
  const names = []
  for (const words of segments) {
    for (const group of parseSegment(words, state)) {
      const name = groupName(group)
      if (!name) continue
      for (let i = 0; i < group.count; i++) {
        if (names.length >= MAX_SPLIT_DAYS) return names
        names.push(name)
      }
    }
  }
  return names
}

// The DAY_TYPES entry a day's name refers to ('shoulder day' → Shoulders, 'Legs & Abs' → Legs,
// 'Day off' → Rest), or null for a custom name ('Hot Yoga').
export function matchDayType(name) {
  const group = firstGroup(name)
  return group && group.type ? DAY_TYPE_BY_ID.get(group.type) : null
}

// Suggested exercises for a day by its name: the matching template day, plus a couple of
// exercises for a second focus in the name ('Legs & Abs', 'Back & Biceps'), at most 8.
// Rest days and custom names get [].
export function dayTemplate(name, makeId = defaultId) {
  if (typeof makeId !== 'function') makeId = defaultId
  const group = firstGroup(name)
  const plan = group && group.type !== 'rest' ? own(ROUTINE_PLANS, group.type) : null
  if (!plan) return []
  const specs = [...plan.exercises]
  const specId = (spec) => spec.split(' ')[0]
  const ids = new Set(specs.map(specId))
  for (const key of group.extras) {
    for (const spec of own(ACCESSORY_PLANS, key) || []) {
      if (specs.length >= MAX_DAY_EXERCISES) break
      if (!ids.has(specId(spec))) {
        ids.add(specId(spec))
        specs.push(spec)
      }
    }
  }
  return specs.map((spec) => planExercise(spec, makeId))
}

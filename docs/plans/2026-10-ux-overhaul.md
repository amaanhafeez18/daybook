# Daybook UX overhaul — October 2026 plan (5 PRs)

Written before handing the work to a cloud session. It holds everything that only existed locally:
the owner's UI rules, the verified findings of a 7-reviewer UI review (94 findings → 32, each checked
against the code: 23 confirmed, 9 real but partly overstated, with corrections noted), and the spec
for exercise visuals. **This repo is public: no personal data in here, in PRs or in commits.**
File:line references were correct on 2026-10-05 (main at `4fbba39`); re-check them before editing.

---

## 0. How to work in the cloud (read first)

- The cloud session has **no `.env`**: no Supabase keys, no OpenAI key, so no `vercel dev` with the
  API and no live-database testing. Do not ask for or invent secrets. Never enter passwords anywhere.
- Per PR: branch from the latest `origin/main` → change → `npm test` → `npm run build` →
  `node --check api/*.js` → commit (end the message with the attribution line from the system
  prompt) → push → open a PR (plain-English body for a non-developer owner: what changed, why, how to
  try it on the phone) → wait for the Vercel check → merge (`--merge --delete-branch`; the owner
  asked for auto-merge) → next PR from the new main. If `gh` is unavailable, use whatever PR tooling
  the session has; if merging isn't possible, leave the PRs open and say so in the final message.
- **Visual checks without the API:** if a headless browser is available (e.g. `npx playwright`),
  you may run `npm run dev` (Vite only) and stub `/api/*` with a throwaway local mock that returns
  fixture data (never committed), to screenshot screens at 375×812. Otherwise rely on tests, build
  and careful reading, and list in each PR body what the owner should check on the phone.
- Write unit tests for every new pure helper (`node --test tests/`). Keep `lib/gym/schedule.js`,
  `library.js`, `stats.js`, `units.js` free of browser/React code (they're imported by `api/`).
- **Never change the owner's data automatically.** Features that fix existing data (e.g. re-linking
  workouts) must ask with one tap and offer Undo.
- No Supabase schema changes are needed for anything below. If one becomes unavoidable, add a
  migration in `supabase/migrations/`, keep the code working without it (tolerant), and list the SQL
  for the owner in the PR body.
- Keep `staticInstructions()` in `api/assistant.js` byte-identical between messages (prompt cache);
  put per-turn content in developer notes. If you add an app feature, add/extend the matching
  assistant tool (see CLAUDE.md).
- Final message to the owner: a short plain-English list of what shipped per PR, anything left
  undone, and what to check on the phone.

## 1. The owner's UI rules (from the local `.claude/ui-contract.md`)

Goal: shippable to a wide audience, **without removing any functionality**. Simple by default,
complete one tap away. Consistent across the whole app.

1. One obvious primary action per screen; everything else secondary or behind a disclosure/menu.
2. Progressive disclosure, one pattern, natural progression — **no global "advanced mode"** (the
   owner rejected it): essentials first; the rest under `<Disclosure id label summary hasValues>`
   (`src/components/ui/Disclosure.jsx`), which remembers per device whether it was left open and
   opens by itself when something inside is set.
3. Forms: at most ~4 fields visible by default; the rest in one "More options" disclosure with a
   summary of what's set; sensible defaults prefilled; Save always reachable, never disabled without
   an inline reason.
4. Menus (⋯ / action sheets): max 6 items, grouped by intent, destructive last and red, the same
   wording everywhere ("Delete", "Remove", "Move to…", "Copy to…").
5. Settings: grouped inset lists, a one-line description under anything non-obvious, rare settings in
   an "Advanced" disclosure at the bottom; keep every setting.
6. Empty states: one sentence + one primary action (+ at most one secondary). First-run hints: a
   single dismissible hint card, never a wall of text.
7. Wording: plain, short, friendly; same nouns everywhere (Task, Event, Class, Person, Catch-up,
   Workout, Routine, Split, Exercise, Meal, Food, Weigh-in, Goal). No jargon on the default path.
8. Numbers & units: always with a unit; big numbers grouped; times 12-hour; dates "Thu, Sep 25".
9. Touch: ≥44px targets, ≥16px inputs (iOS zoom), swipe actions keep a visible button alternative,
   safe-area insets, no horizontal overflow at 375px, desktop keeps working.
10. Consistency: reuse `components/ui` (Sheet, Field, Switch, Segmented, Button, Card, EmptyState,
    Disclosure). Don't restyle primitives; prefer area CSS files with specific selectors over editing
    App.css/glass.css/apple.css (later files win at equal specificity — check all three). Light + dark
    + all 12 accent themes.
11. Nothing removed: every control, setting, action and input stays reachable; deep links, hash
    routes, section ids and the assistant's pointers keep working.
12. Undo over confirm: actions get a toast with Undo; `confirmAction` only for permanent deletes.
13. Spaces and areas: phones have two spaces (Plan | Health pill in the top bar, `App.jsx`); optional
    areas (`lib/areas.js`) must be respected everywhere (`useAreas()` / `areasFrom(settings)`). Never
    add a fourth top-bar icon.

---

## PR 1 — Daily bugs (small, high value)

1. **Sync badge covers "Plan" and spins on every open** (shell-1). `SyncStatus` renders inline after
   the avatar (App.jsx ~325-329) while the Plan|Health pill is absolutely centred (shell.css ~55-64),
   so an "Offline" badge paints over "Plan". `refresh()` sets `syncing:true` on every launch/return
   (store.js ~345, App.jsx ~212-224), so the spinner shows even when nothing is being saved.
   *Fix:* render `<SyncStatus/>` inside `.topbar-actions` (right side; empty in the Health space);
   while spaces are on, always the compact 28px circle (keep "Offline" in aria-label and tap toast);
   spin only for real saves (`pendingSaves > 0`) older than ~800ms; background refreshes silent.
   *Verifier correction:* "offline" is set only when a fetch throws with no network (status 0;
   store.js ~391/460), not on slow requests (those become a 408 save error, api.js ~104-107).
2. **Rejected saves look saved** (shell-2). `SyncStatus` ignores `saveError`; the toast fires once
   (App.jsx ~399-411); store.js ~459-466 resets pendingSaves; retries fail silently.
   *Fix:* add an `'error'` badge state (small red alert circle, label "Some changes aren't saved");
   tap → toast with the server message + "Retry" (`retryUnsaved`). Stays until a save succeeds.
   Error toasts last ~8s.
3. **Impossible weights become records and next session's targets** (gym-2). Any weight is accepted
   (common.jsx ~181-185 `WeightInput`; ticking a set only checks for empties, ExerciseLog.jsx
   ~592-655); placeholders come from the previous session first (~266-276), so a typo (e.g. 850 for
   85) becomes the BEST set, inflates e1RM/volume stats and is suggested next time.
   *Fix:* a pure `plausibleWeight({ kg, exerciseId, history, equipment })` in `lib/gym/stats.js`
   (flag > ~2.5× the exercise's previous best working weight, or above a sane cap per equipment when
   there's no history; never block). On ✓ and in FinishSheet, show an inline row prompt
   "Did you mean 85 kg?" [85 kg] [Keep 850] (suggest ÷10 when that is plausible). The assistant's
   `gym_log_workout` should return a warning asking to confirm. On the exercise page, a flagged BEST
   row offers "Fix this set" (opens the session). Do **not** edit existing sessions automatically.
4. **Old workouts point at deleted routines** (gym-1). Rebuilding the plan (Start over → template or
   wizard) creates new routine ids (state.js ~517-526; GymSettingsSheet.jsx ~228-244 keeps history),
   so past sessions show "Deleted routine", routine cards say "Not done yet", the History routine
   filter disappears and "previous: same routine" targets find nothing (RoutinesTab.jsx ~117-121,
   HistoryTab.jsx ~226-229, SessionDetail.jsx ~118/159-161).
   *Fix:* pure helper `orphanMatches(sessions, routines)` (sessions whose routineId no longer exists
   and whose name matches a current routine, case/space-insensitive) + `relinkSessions(matches)` in
   `lib/gym/state.js` (one batched save, Undo). Offer it, don't do it silently: after saveRoutine /
   applyTemplate / the wizard creates a matching routine, toast "Link 4 past Push workouts? · Link";
   on the Gym Routines tab show a one-time card when orphans with matches exist; on a session page
   the "Deleted routine" chip opens "Link to a routine…".
5. **See-through sticky bars.** Gym section tabs (gym-10): give `.segmented.gym-shell-tabs` a solid
   glass background + backdrop blur (match routines.css ~171-177). Assistant "Prompts" pill
   (assistant-5): give `.asst-start-btn` the same glass background/blur as `.asst-tip`; also add a
   compact ⋯ button to that dock row (AssistantPage.jsx ~796-803) opening the same menu upward (the
   header ⋯ is thousands of px away in a long chat). No new top-bar icon.
6. **Expired assistant card is a dead end** (assistant-1). An expired card has no buttons
   (AssistantPage.jsx ~1088/1097/1132-1139, TTL ~25). The server already re-stages a Yes on a stale
   card (api/assistant.js ~5576-5595). *Fix:* on the newest message, an expired card shows a
   secondary "Still want this? Check again" button that sends Yes; `send()` must not flip an expired
   card to 'executing' (~295). Optional: a small dot on the Assistant tab while a card waits.
7. **Stray avatar on desktop** (shell-9): `@media (min-width:900px){ .topbar .topbar-brand{display:none} }`
   in shell.css (glass.css overrides the old rule).
8. **Tap targets ≥44px** (shell-7): Plan|Health buttons are 28px (shell.css ~65; also centre the pill
   vertically with the avatar), sheet × 32px (apple.css ~212), gym ✓ 44×38 (workout.css ~368-371),
   set-number column 34-36px (~252-255), gym section tabs 36px (gym.css ~28-31), Settings prayer chips
   36px (SettingsPage.jsx ~668). Use the `::after` hit-area trick (today.css ~52) so looks don't
   change. *Already fine (skip):* class-sheet chips and Task Due chips.
9. **Tidy weights** (gym-5): `formatWeight` (units.js ~37-42) always uses 2 decimals, so kg-stored
   values show as "44.09 lb". Show whole numbers when within ~0.15 of one, else 1 decimal; group
   thousands (Intl.NumberFormat) in formatWeight only (volumes are already grouped); don't repeat the
   unit on every row under an "lb × reps" header (SessionDetail.jsx ~254-264 / HistoryTab.jsx
   formatSetValue ~73-97). Inputs keep full precision. Update tests/gym-stats.test.mjs (~427).

## PR 2 — iPhone typing and sheets

1. **Sheets hide behind the iPhone keyboard** (shell-3). No visualViewport handling anywhere;
   `.sheet-layer` is fixed to the bottom (App.css ~387-393, glass.css ~230-235). *Fix:* a
   `useKeyboardInset()` effect in Sheet.jsx: while a sheet is open, listen to `visualViewport`
   resize/scroll, set `--kb` (keyboard height) and `--vvh` (visible height) on `<html>` and toggle
   `html.kb-open`; CSS `.sheet-layer{bottom:var(--kb,0px)}`,
   `.sheet{max-height:calc(var(--vvh,100dvh) - var(--safe-top) - 16px)}`, drop the home-indicator gap
   while open; scroll the focused field into view; lift toasts by `--kb` too.
2. **Accidental close loses typed text** (plan-3). Backdrop tap / swipe / Escape closes every form
   sheet (Sheet.jsx ~96, ~130-133); task, class, person and catch-up sheets reset on open
   (TaskSheet.jsx ~135-137, ClassSheet.jsx ~53-60, PeoplePage.jsx ~404/557/869-882). *Fix once in
   Sheet:* optional `draftKey` + `isDirty`/`getDraft`/`restoreDraft` props; when a dirty sheet closes
   without saving, keep the draft (sessionStorage, keys like `task:new`, `class:new`,
   `catchup:<friendId>:<date>`) and toast "Draft kept · Reopen"; reopening restores; saving clears.
   No confirm dialogs (rule 12). Gym editors already guard their own drafts — leave them.
3. **Undo toasts** (shell-8): 7s default when a toast has an action; pause on touch/hover/focus; swipe
   to dismiss; on phones at most 2 visible, merge repeats ("Completed (3)", Undo the last); while a
   sheet is open show toasts at the top; colour only the leading icon red on error toasts
   (feedback.jsx ~366).
4. **Food quick-add tray fits a phone** (food-2): header wraps to two rows (food.css ~262-265) and the
   focused tray is capped at `min(260px, 30vh)` (~295) → ~1.5 rows visible. Put the meal picker and
   Suggested/Recent/My foods tabs on one row; move "Add by hand" / "Quick calories" to two rows at the
   bottom of the list; focused cap ~`min(320px, 38vh)` or from visualViewport so 3-4 rows show; use
   "What did you eat?" as the placeholder in both QuickAddBar (~235-243, ~310) and FoodQuickCard
   (~219) (barcode lives in the camera menu).
5. **Journal past entries** (people-journal-1): tapping a past entry (JournalPage.jsx ~241 → goTo
   ~135-138) doesn't scroll the editor into view; add smooth scroll (instant with reduced motion), a
   "Today" chip in the date bar when not on today (~164-172), and for older days a header like
   "Wed, Sep 23" with "12 days ago" underneath instead of the date twice (~167-168).

## PR 3 — Faster everyday actions

1. **Task sheet understands "tomorrow 5pm"** (plan-2): run `parseQuickAdd` on the title while
   creating (or editing an undated task), show the same dismissible "understood" chip as the quick-add
   dock, fill date/time live, save the cleaned title unless dismissed. Reuse the dock's logic.
2. **"Later…" snooze** (plan-1): a third swipe action and a footer button on reminder-opened sheets:
   action sheet "In 1 hour" (timed only) / "This evening 6 PM" / "Tomorrow" / "This weekend (Sat)" /
   "Next week (Mon)" / "Pick a date…", applied immediately with Undo. Keep "Tomorrow" as the one-tap
   swipe. Put the presets in one pure helper in `lib/dates.js` (tested).
3. **Due row** (plan-4): one shared preset helper so the sheet's "Next week" (today+7,
   TaskSheet.jsx ~83) and quick add's "next week" (next Monday, dates.js ~357) agree, and chips say
   their day ("Next week · Mon", "Weekend · Sat"); a readable line under the chips
   ("Wed, Oct 7 · 1:30 PM · in 2 days"); once a date is set, time chips "9 AM · 12 PM · 3 PM · 6 PM ·
   Any time" next to the native input (give the time input ≥ ~118px or stack under 360px).
   *Correction:* the clipped date/time text was Chrome desktop rendering; the missing weekday is real.
4. **Food: add several in a row** (food-1): after a tap-log from the tray keep it open and focused,
   mark the row "Added ✓" (tap again to undo that item), footer "2 added · 422 kcal · Done", one
   summary toast with "Undo all" on close instead of one per item.
5. **Food shortcuts** (food-3, food-4): on the Health → Today food card add up to 3 one-tap chips
   for the current meal (reuse DayView's EmptyMeal chip logic, DayView.jsx ~423-470;
   `suggestions()` is in `src/lib/food/nutrition.js` ~879) — hide while an estimate is open. "Same as
   yesterday" → "Same as <day>" looking back up to ~14 days for that meal (existing `copyMeal`).
   Show a muted calorie count on suggestion chips ("Oatmeal · 152").
6. **Workout auto-advance** (gym-4): when the ticked set was the exercise's last open set, scroll to
   the first open set of the next exercise (WorkoutScreen doesn't pass `onSetDone` — the prop exists
   at ExerciseLog.jsx ~400/411; reuse the superset scroll-and-flash ~625-638). Stats strip
   "Sets 6 / 16". *Correction:* Finish is already sticky and visible; an "All sets done" bar is
   optional emphasis only.
7. **Assistant: a middle confirmation level** (assistant-2): `assistantConfirm` gains `'changes'`
   (ask only for edits, deletes and schedule changes; creates and logs — create_task, create_event,
   food_log, log_contact, gym_quick_log, gym_log_bodyweight, save_note, … — run straight away). The
   server's `confirmMode` becomes a per-tool decision (api/assistant.js ~582 enum, ~5674). Settings →
   Assistant: replace the switch (SettingsPage.jsx ~171-177) with a Segmented "Always ask / Only edits
   & deletes / Never". Finished actions get an "Undo" chip that calls a new server `undo` action
   deleting the ids the tools returned (store those ids on the assistant message). Default stays
   "Always ask". Extend `update_settings` (`assistantConfirm` enum) and its wording. Tests.
   **Safety:** turns that include web content or attachments, and anything destructive, always stage.
8. **Shorter chats** (assistant-4): on a confirm turn the reply is "Done ✓" + the day-total line where
   relevant, and action chips whose text already appears in the reply are hidden (keep failures);
   Replaced/Expired/Cancelled cards not on the newest message collapse to one muted line that expands
   on tap; names cut at a word boundary with "…" (or allow 60 chars) — keep `clean()` for stored values.
9. **Start screen fits the space** (assistant-3): pass the current space into `buildSuggestions`
   (AssistantPage.jsx ~911-928). Health: "Log a meal…", calories left, today's workout, "Log my
   weight…". Plan: tasks and people first. Add starter chips that *fill* the composer instead of
   sending ("I had ", "Remind me to "). Context placeholders. Returning users: hide the big avatar and
   paragraph so all prompts fit above the composer; timetable hint only in Plan when there are no
   classes; under Continue, "New messages continue this chat"; make "Start fresh" a 44px button.

## PR 4 — Easier setup

1. **"Get set up" card on Today** (setup-1): accounts younger than ~14 days, or until dismissed
   (`settings.setupHidden`), one card "Get set up · 2 of 5 done" built from the areas that are on;
   rows tick themselves off from data and link straight to setup: Add your timetable (ClassSheet, plus
   "from a photo" → `#/assistant/timetable` attach flow), Pick a gym plan (`#/gym`), Set your calorie
   goal (`#/food/goals`), Add people (add-person sheet), Use my location, Turn on reminders. Make the
   tour's last-screen rows (WelcomeFlow.jsx ~490-509) tappable; point HealthGlance's no-plan row at
   `#/gym` (HealthGlance.jsx ~20). Respect areas. Only one hint card on Today at a time.
2. **Location dead end** (setup-4): `useLocation` (environment.js ~42-94) ignores the account's saved
   `settings.location`. Quick part: fall back to it ("Using your saved location · Update") instead of
   the blocked message (TodayPage.jsx ~360-375; PrayerCard returns null without coords ~491). Then a
   Location row in Settings → Prayer times: "Current location (updated 2 days ago)" / "Not set",
   "Use my location" and "Choose a city" (Open-Meteo geocoding search, free, no key:
   `https://geocoding-api.open-meteo.com/v1/search?name=…`), saving `{lat, lon, name, manual:true}`
   which GPS won't overwrite; offer "Choose a city" in the Weather card's blocked state and in the
   prayer-reminder hint (SettingsPage.jsx ~652-657). Server prayer reminders already read
   `settings.location` — keep `savedLocation()` compatible.
3. **Faster timetable** (setup-3): a new class defaults its end date to the most common future end
   date among existing classes; setting a start time with an empty end fills the end from the last
   class's length (else 50 min); "Save & add another" keeps days/times/end date and clears the name;
   Settings → Classes gets "Add from a photo of your timetable" (opens the assistant attach flow; the
   picker still needs the user's tap).
4. **Reminders on the iPhone** (setup-6): on Today, in the Home Screen app with `pushSupport()` ===
   'default' and the hint not dismissed: "Get reminders on this iPhone" [Turn on] (calls
   `enableNotifications` inside the tap) [Not now]; in iOS Safari a one-time "Add Daybook to your Home
   Screen for reminders" card with the tour's steps (if the Get set up card ships, make these its rows
   instead of a second card). A reusable "Notifications are off on this iPhone · Turn on" row under the
   gym and prayer reminder switches when this device isn't subscribed. *Correction:* Settings →
   Notifications already has a "This device · Turn on" row; there is no food reminder switch.
5. **Settings as the hub** (setup-8): under each area that's on in "What you use", a chevron row with
   status: "Gym settings · <split>" or "No plan yet · Set up" (new route `#/gym/settings` opening the
   existing sheet), "Food goals · <kcal>" or "No goal yet" (`#/food/goals`), "My foods"
   (`#/food/foods`); replace the assistant-memory footnote with a row "What the assistant remembers
   (N)" (new route `#/assistant/memory` opening the existing sheet); move "Welcome tour" into a small
   Help group with "Add Daybook to your Home Screen". Keep every old entry point.
6. **Food goals open on a summary** (food-6): when a calorie goal exists, open on "<kcal> ·
   P · C · F" and what it was based on, with "Adjust numbers" (manual fields prefilled) and
   "Recalculate" (the wizard, prefilled; note if the weight is old). New profiles preselect activity
   from the gym plan (0-1/wk light, 2-4 moderate, 5+ very active) with a "From your gym plan" note.
7. **Weekly gym goal follows the plan** (gym-3): treat an unset goal as "follow my plan" (weekly:
   count workout days; rotation: round(workouts × 7 / cycle length)); Gym settings shows
   "Weekly goal: 5 (from your plan)"; touching the stepper makes it manual. Pure helper + tests.

## PR 5 — Exercise visuals (new feature, requested by the owner)

**Goal:** for every exercise, a visual that tells you *at a glance* what the exercise is: the body
position, the movement, the equipment and the muscles worked. Meaningful, not decorative.

**Approach (self-contained, offline, themeable — no image hosting, no third-party assets):**
1. **Animated figure** (`src/pages/gym/visuals/`): a side-view SVG figure (rounded limb capsules, head,
   torso) posed by joint angles (hip, knee, ankle, shoulder, elbow, wrist, trunk lean), with equipment
   drawn in a neutral colour (barbell + plates, dumbbells, cable line + pulley, bench flat/incline/
   decline, machine seat/pad, pull-up bar, kettlebell, band, floor mat). Each **motion pattern** has
   2-3 keyframe poses; the figure loops between them (~2.2-2.8s, ease-in-out, short holds at the ends)
   so the plane and range of motion are obvious. The working limb/torso segments are tinted with the
   accent colour. `prefers-reduced-motion`: show a static two-pose overlay (start faint, end solid)
   instead of animating. Pause animation when off-screen (IntersectionObserver) and when the tab is
   hidden. Pure SVG + one rAF loop (or SMIL/CSS) — no libraries.
2. **Muscle map:** a small front + back body silhouette with the exercise's `primary` muscle filled in
   the accent colour and `secondary` muscles in a lighter tint, using `MUSCLES` ids from
   `lib/gym/library.js` (chest, shoulders, triceps, biceps, forearms, lats, upper_back, traps,
   lower_back, abs, glutes, quads, hamstrings, calves, adductors, abductors; full_body/cardio = whole
   body highlight).
3. **Mapping:** the library has 124 exercises (fields: id, name, primary, secondary, equipment,
   category, movement, tracking). Add an explicit table `EXERCISE_MOTION: { [id]: { pattern, variant } }`
   covering **every** library id (variant = bench angle, grip, stance, one-arm, seated/standing…).
   Patterns (~30): horizontal press (bench flat/incline/decline; barbell/dumbbell/machine/smith),
   push-up, dip, chest fly (DB/cable/machine), overhead press, lateral raise, front raise, rear-delt fly,
   upright row/shrug, row (bent-over BB/DB one-arm/seated cable/machine/T-bar), pull-up/chin-up, lat
   pulldown, straight-arm pulldown, face pull, curl (BB/DB/hammer/cable/preacher), overhead triceps
   extension, pushdown, skull crusher, squat (back/front/goblet/smith/hack), leg press, lunge/split
   squat/step-up, leg extension, leg curl (lying/seated), hip hinge (deadlift/RDL/good morning/
   kettlebell swing), hip thrust/glute bridge, hip abduction/adduction machine, calf raise, crunch/
   sit-up/cable crunch, plank/side plank (hold), hanging leg raise, Russian twist/woodchop, farmer's
   carry, cardio (run/treadmill, bike, rower, elliptical, jump rope, stairs).
   **Custom exercises** (user-made, `gym.exercises`): choose a pattern from keywords in the name +
   `movement` + `equipment` + primary muscle; if nothing fits, show the muscle map alone.
4. **Where it shows:**
   - Exercise detail page (ExerciseDetail.jsx header): large animated figure + muscle map side by side,
     plus 2-3 short form cues per pattern ("Feet shoulder-width · sit back and down · knees over toes").
   - Live workout (ExerciseLog cards): a small thumbnail next to the exercise name; tapping it opens a
     sheet with the large animation, muscles and cues (don't make the card taller).
   - Exercise picker and library rows, routine editor rows, gym Today exercise list: small static
     thumbnail (the "end" pose), animating only while pressed/hovered or when the row is expanded.
   - Assistant: no change needed.
5. **Quality bar:** someone who has never lifted should be able to tell, without reading the name,
   whether they're lying, sitting or standing, what moves, and which muscles work. Proportions
   consistent across all patterns; looks right in light and dark mode and every accent theme; crisp at
   24px (thumbnail) and ~220px (detail). Keep the whole feature a lazily loaded chunk (no growth of the
   first bundle).
6. **Review gallery:** a hidden route `#/gym/visuals` (not linked anywhere) that renders every
   library exercise's figure + muscle map in a grid with names, so the owner (and you, with a headless
   browser if available) can review all 124 at once.
7. **Tests:** every library id has a mapping; every pattern's keyframes are well-formed (finite
   numbers, all joints present, angles in range); custom-exercise fallback picks sensible patterns
   for sample names; `renderToString` of a few patterns produces valid SVG.

## If time remains (verified, below the top-30 cut — roughly in value order)

Insights averages count partly logged days (food-8) · Insights opens on an empty week every Monday
(food-7) · remember each tab's scroll position (shell-5) · one catch-up nudge on Today; ticking
"Talk to …" offers a note (people-journal-4) · catch-up sheet: "Skip" actually logs; change the day in
place (people-journal-3) · the tour's Tasks and Classes picks do nothing (setup-2) · prayer settings in
one place (setup-5) · one app-wide week start; units guessed from the device (setup-7) · first-time
phone visitor sees "Welcome back" (setup-9) · "Log a past workout" in the gym Today ⋯ and History
(gym-6) · start a workout without picking a plan (gym-7) · a weight typed in set 1 carries down in the
routine editor (gym-9). Not wanted without the owner's decision: silent service-worker updates
(shell-6); timed rest-over push in the background (gym-12, large).

# Daybook — notes for Claude

Personal planner PWA (tasks, calendar, people/catch-ups, journal, notes, AI assistant, push reminders).
The owner uses it mainly as an **iPhone home-screen app**; desktop web must keep working too.
Production: https://daybook-smoky-seven.vercel.app · Repo: github.com/amaanhafeez18/daybook

## Working agreement
- For every change: `git pull` on `main` → new branch → make the change → `npm run build` (and `node --check api/*.js`) → test in the browser pane → commit → push → `gh pr create` → wait for the Vercel check (`gh pr checks <branch> --watch`) → **merge it** (`gh pr merge --merge --delete-branch`) → back to `main` and pull. The owner has asked for auto-merge.
- Merging to `main` deploys to production. Anything that needs a Supabase schema change: write a migration in `supabase/migrations/` and give the owner the SQL to run **before** relying on it. Code must keep working if the migration hasn't been run yet (see "tolerant" below).
- Never paste or print secrets. The owner enters keys in Vercel/Supabase themselves. Never enter passwords into the app.
- When testing against the live DB, back up what you touch, use `zz-` prefixed test data, and remove it afterwards (including test messages in the assistant chat history).
- Explain things simply; the owner is new to PRs and deployment.

## Run locally
- `npm run dev:full` → `vercel dev` (Vite + `/api` functions) on http://localhost:3000. `npm run dev` is frontend only.
- Local secrets live in `.env` (git-ignored; `vercel dev` reads `.env`, not `.env.local`). Browser-pane launcher: `.claude/launch.json` (name `daybook`).
- Editing `vite.config.js` or `.env` requires restarting the dev server (vercel dev's proxy breaks after Vite restarts).
- Windows machine: Bash heredocs choke on apostrophes/quotes in long scripts — write scripts to a file (e.g. `.claude/tmp.py`, then delete) or use the Edit tool. PowerShell here-strings break on quotes too; use `--body-file` for PR bodies.

## Architecture
- **Frontend** (`src/`): React 18 + Vite 5, hash routes (`#/today`, `#/tasks`, `#/calendar`, `#/people`, `#/assistant`, `#/journal`, `#/settings`). `App.jsx` = shell (auth, nav, lazy-loaded pages, sync badge, iOS-style title bar).
  - `lib/store.js` — shared data store. Renders from localStorage cache, refreshes with one `GET /api/data?keys=…`, edits apply immediately and save as **PATCH diffs** (lists: `{key, upsert, delete}`; settings: `{key:'settings', set}` field-level). Retries offline, flushes when backgrounded. Use `useData(key)`, `updateData`, `updateSettings`.
  - `lib/planner.js` — all domain operations. **Invariant:** a dated task has a linked calendar event (`event.taskId` / `task.calendarEventId`); calendar events created directly also create a task. Always go through these helpers so the pair stays in sync. Friend reminder tasks have `details = "friend-reminder:<friendId>:<date>"`.
  - `lib/api.js` (fetch + session), `lib/dates.js`, `lib/environment.js` (location, weather, prayer times), `lib/notifications.js` (push subscribe), `lib/theme.js`.
  - UI kit in `components/ui/` (Sheet = bottom sheet/dialog, `toast()` with Undo, `confirmAction()` for permanent deletes only, primitives).
  - **Styles:** `App.css` (design system) → `glass.css` (Liquid Glass layer) → `apple.css` (Apple polish). Loaded in that order, so later files win at equal specificity — check all three before changing a component's look.
- **Backend** (`api/`, Vercel Node functions, ESM; `_`-prefixed files are shared modules):
  - `db.js` Supabase client (must be the **secret** key; RLS is ON with no policies), JWT helpers with `token_version` session revocation, rate limiting.
  - `auth.js` signup/login/reset (personal hashed recovery question), password change, sliding session renewal.
  - `data.js` GET/PUT/PATCH; `COLUMNS` whitelist + camelCase↔snake_case `FIELD_TO_COLUMN`. Saves are **tolerant**: a column missing in the DB is dropped and retried. New task/friend fields must be added to `COLUMNS` and `FIELD_TO_COLUMN`.
  - `assistant.js` OpenAI Responses API tool loop (default `gpt-5-mini`, low reasoning, `store:false` + encrypted reasoning), NDJSON streaming, voice transcription (`gpt-4o-mini-transcribe`), memories, snapshot of all user data in the instructions, tools for everything the app can do (tasks, events, people, classes, journal, notes, memories, settings incl. notifications, weather, prayer times). If you add an app feature, add a matching tool.
  - `_reminders.js` + `cron.js` (called every minute by Supabase pg_cron + pg_net with `CRON_SECRET`; `?dryRun=1&all=1&at=<ISO>` to test) + `push.js` (subscribe/test). `public/push-sw.js` is imported into the Workbox service worker.
- **Data model quirks:** `classes.days` is either `["Mon",…]` + `day_details` or `[{day,time,room}]`; settings JSON keys: `appearance`, `theme` (accent), `displayName`, `showPrayerTimes`, `prayerMethod`, `prayerSchool`, `timeZone`, `notifications{…}`. Notification defaults exist in both `api/_reminders.js` and `src/lib/notifications.js` — keep them in sync.

## Environment variables (Vercel: Production + Preview)
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (secret `sb_secret_…` key — the public key sees no rows because RLS is on), `JWT_SECRET`, `OPENAI_API_KEY`, `OPENAI_MODEL` (`gpt-5-mini`), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `CRON_SECRET`. Optional: `ALLOW_SIGNUPS=false`, `ASSISTANT_DAILY_LIMIT`, `OPENAI_REASONING_EFFORT`, `VAPID_SUBJECT`.

## Supabase migrations (run in order in the SQL editor)
`supabase/schema.sql` for a fresh DB, then every file in `supabase/migrations/` by date. The notifications one needs `YOUR_CRON_SECRET` replaced. Possibly still pending for the owner (verify before assuming): `2026-09-24-notifications.sql`, `2026-09-25-cron-log-cleanup.sql`, and the push/cron env vars in Vercel. Check what exists with a read-only query using the local secret key if needed.

## iPhone specifics
Inputs must be 16px (else iOS zooms); the tab bar hides while typing; speech/audio must start from a tap; push works only when installed to the Home Screen (iOS 16.4+); updates show an "Update" toast (prompt-based service worker).

## Ideas backlog (owner may ask for these)
Recurring tasks, natural-language quick add, Apple Calendar subscription (ICS feed), Siri/Shortcuts endpoint, habits with streaks, AI morning briefing, subtasks/lists/tags, journal photos + mood chart, global search, passkey (Face ID) login, data export/delete account, automated tests + CI, error tracking.

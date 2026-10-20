# Daybook

A personal planner that lives on your iPhone's Home Screen (it also works in any desktop browser).
Production: https://daybook-smoky-seven.vercel.app

## What it does

The app has two spaces, switched by the `Plan | Health` pill at the top (on a desktop they are groups in the sidebar).

**Plan**
- **Today**: your agenda with a Now/Next line, overdue and due-today tasks, "Coming up" deadlines (with study blocks you can plan in one tap), "Usually today" suggestions learned from what you repeat, an optional AI-written morning note, and an evening check-in with mood.
- **Tasks**: quick add that understands dates in the title ("dentist tomorrow 3pm", "the 15th", "lunch"), "!" for urgent, snooze with "Later…", and clash warnings when a task overlaps a class or event.
- **Calendar**: events and classes. Every dated task has a matching calendar event, and the two stay in sync.
- **People**: friends, catch-up reminders, and a "Talked to Sam? · Log catch-up" offer when you tick a task that names someone.
- **Journal** and **notes**, with photos and files attached to tasks, notes or people.

**Health**
- **Gym**: workout schedule ("shift" moves it forward), routines, live workout logging, personal records, stats, and animated pictures of each exercise.
- **Food**: food log with barcode and web lookups, "My foods", meal shortcuts, goals, and a coach that measures your real maintenance calories from what you eat and your weight trend.
- **Weight**: weigh-ins with a weekly trend.

**Assistant** (in both spaces)
- Chat that can do anything the app can: add and move tasks, log food and workouts, write the journal, change settings. It asks before making changes (Settings decides how often) and every change has an Undo.
- **Voice chats**: talk to it like a phone call. Costs about 3–5¢ a minute, with daily and monthly limits in Settings → "Voice & AI cost".

**Reminders**
- Push notifications for tasks, the morning summary, the evening check-in, workouts and (optionally) prayer times, with quiet hours. Several reminders due together arrive as one notification.
- Optional red number on the app icon for overdue and due-today tasks.

Optional areas (People, Journal, Gym, Food) can be switched off in Settings → "What you use". With Gym and Food both off there is no Health space.

## How it's built

- **Frontend**: React 18 + Vite 5, installable PWA (service worker, offline cache, launch images).
- **Backend**: Vercel serverless functions in `api/`, pinned to the `pdx1` region (Portland) to sit next to the database.
- **Database**: Supabase Postgres in `us-west-2` (Oregon). Row Level Security is on, so only the server (with the secret key) can read data.
- **AI**: OpenAI. Text model set by `OPENAI_MODEL` (default `gpt-5-mini`, which OpenAI shuts down on **2026-12-11**; switch the variable before then), `gpt-realtime-2.1-mini` for voice chats.
- **Reminders**: Supabase `pg_cron` calls `/api/cron` every minute; pushes are sent with Web Push (VAPID keys).
- **Login**: username + password, a signed token kept on the device, password reset with a personal recovery question (stored hashed), lockout after repeated wrong guesses, and other devices signed out after a password change.

Developer notes (architecture, conventions, where things live) are in [`CLAUDE.md`](CLAUDE.md).

## Run it on your computer

1. Copy `.env.example` to `.env` and fill in the values (`vercel dev` reads `.env`, not `.env.local`).
2. Run:

```bash
npm install
npm run dev:full
```

This starts the app and the `/api` functions at http://localhost:3000. The first run asks you to log in to Vercel and link the project. `npm run dev` starts only the frontend, without the API.

Changing `.env` or `vite.config.js` needs a restart of the dev server.

## Check a change

```bash
npm run build          # the app still builds
npm test               # all tests (needs Node 20)
node --check api/*.js  # the API files have no syntax errors
```

Run all three before every pull request. Merging a pull request into `main` deploys it to production.

## Set up Supabase

1. Create a Supabase project and open the SQL Editor.
2. Run `supabase/schema.sql`, then every file in `supabase/migrations/`, oldest first:

| File | What it adds |
| --- | --- |
| `2026-09-22-add-missing-columns.sql` | Friend and class columns older databases were missing |
| `2026-09-22-assistant-memories.sql` | The assistant's memories |
| `2026-09-23-auth-hardening.sql` | Login lockout, signing other devices out, usage limits |
| `2026-09-23-enable-rls.sql` | Row Level Security (**required**, or the public key can read your data) |
| `2026-09-24-notifications.sql` | Push reminders and the every-minute scheduler (replace `YOUR_CRON_SECRET` first) |
| `2026-09-25-cron-log-cleanup.sql` | Clears old reminder logs |
| `2026-09-26-gym.sql` | Gym sessions, body weights, field-level settings saves |
| `2026-09-27-food.sql` | Food log |
| `2026-09-28-tasks-completed-at.sql` | When a task was ticked (used for "Usually today") |
| `2026-09-29-attachments.sql` | Photos and files on tasks, notes and people |

3. Copy the project URL and the **secret** key (`sb_secret_…`) into `.env` and into Vercel.

The app keeps working if a newer migration hasn't been run yet; the feature that needs it just stays off.

## Deploy to Vercel

The repository is connected to Vercel: every pull request gets a preview, and merging into `main` updates production.
Set these under Project Settings → Environment Variables (Production and Preview):

**Required**

| Variable | What it is |
| --- | --- |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | The Supabase **secret** key (`sb_secret_…`), not the publishable one |
| `JWT_SECRET` | Any long random string (signs login tokens) |
| `OPENAI_API_KEY` | OpenAI key for the assistant, voice chats and food lookups |
| `OPENAI_MODEL` | Text model, e.g. `gpt-5-mini` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Push keys: `npx web-push generate-vapid-keys` |
| `CRON_SECRET` | Random string; must match the one in the notifications migration |

**Optional**

| Variable | What it does |
| --- | --- |
| `ALLOW_SIGNUPS=false` | Closes new sign-ups |
| `ASSISTANT_DAILY_LIMIT` | Assistant messages per account per day |
| `OPENAI_REASONING_EFFORT` | `low` (default) or `medium` |
| `OPENAI_WEB_MODEL` | Model for web lookups (defaults to `OPENAI_MODEL`) |
| `OPENAI_BRIEFING_MODEL` | Model for the AI-written morning note (defaults to `OPENAI_MODEL`) |
| `AI_BRIEFING=off` | Turns the AI-written morning note off for everyone |
| `OPENAI_TRANSCRIBE_MODEL` | Voice-note transcription (default `gpt-4o-mini-transcribe`, deprecated: move off it before 2027-02-26) |
| `OPENAI_REALTIME_MODEL` | Voice chat model (default `gpt-realtime-2.1-mini`) |
| `OPENAI_REALTIME_TRANSCRIBE_MODEL` | Voice chat captions (default `gpt-transcribe`) |
| `VOICE_CHAT=off` | Turns new voice chats off for everyone (typing keeps working) |
| `VAPID_SUBJECT` | Contact for push services, e.g. `mailto:you@example.com` |

## Install it on iPhone

1. Open the production URL in Safari.
2. Tap Share → **Add to Home Screen**.
3. Open it from the Home Screen. Push notifications and the icon number only work in the installed app (iOS 16.4 or later); turn them on in Settings → Notifications.

Updates install themselves quietly when you come back to the app after 10+ minutes, unless you're in the middle of something; otherwise an "Update" message appears. If the launch screen images change, remove and re-add the app to see them.

## Working with Claude Code in the cloud

Cloud sessions run a setup script (`.claude/hooks/session-start.sh`) that switches to Node 20 and installs the packages, so building and testing work straight away.
The cloud machine can only reach GitHub and package downloads by default. To let Claude open the live site, Supabase or OpenAI, add those domains (and any keys, as environment variables) in the cloud environment's settings. Never paste keys into the chat.

With the keys in place, `npm run dev:cloud` runs the app and the `/api` functions on http://localhost:3000 without a Vercel login. Testing uses the `zz-claude` account only; `node scripts/test-login.mjs zz-claude` prints a session token for it (only `zz-` accounts, and only valid on that local server).

## Security note

Login tokens are kept in the browser's storage rather than secure cookies. That's fine for a personal app, but a public product would use HTTP-only cookies and stronger sign-in (for example passkeys).

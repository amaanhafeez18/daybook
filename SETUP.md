# Daybook prototype setup

This project has been converted into a lightweight prototype that supports:

- username/password sign up and login
- persistent login using a saved token in localStorage
- forgot-password flow with the custom question: "What is that you are worried about?"
- shared data across devices via a backend API and database
- Vercel deployment
- iPhone home-screen install

This is still intentionally cheap and simple. It is designed as a prototype, not a production-grade security system.

## 1) Create the database in Supabase

1. Go to https://supabase.com and sign in.
2. Click New project.
3. Pick a project name, password, and region.
4. Wait for the project to be created.
5. Open the SQL editor.
6. Copy the contents of `supabase/schema.sql` and run it.

This creates the app tables plus `assistant_conversations`, which stores each user's recent assistant chat history.

## 2) Copy the environment variables

Create a file named `.env` in the project root by copying `.env.example`. (`vercel dev` reads `.env`, not `.env.local`. Both are git-ignored.)

Example:

```bash
cp .env.example .env
```

Then fill in the values:

```bash
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
JWT_SECRET=some-long-random-secret
OPENAI_API_KEY=sk-your-openai-api-key
OPENAI_MODEL=gpt-4o-mini
```

How to find them:

- `SUPABASE_URL`: open your Supabase project, go to Project Settings → API
- `SUPABASE_SERVICE_ROLE_KEY`: same place, under Project API keys
- `JWT_SECRET`: any long random string like `daybook-dev-secret-abc-123`
- `OPENAI_API_KEY`: create an API key in the OpenAI dashboard. Keep it server-side only.
- `OPENAI_MODEL`: use `gpt-4o-mini` for the lowest-cost fast assistant configuration.

## 3) Install dependencies

```bash
npm install
```

## 4) Run locally

```bash
npm run dev:full
```

This starts the Vercel local environment (Vite + the `/api` routes) at http://localhost:3000. The first run asks you to log in and link the Vercel project. `npm run dev` starts only the Vite frontend, without the API.

## 5) Deploy to Vercel

### Option A: GitHub

1. Push this folder to GitHub
2. Go to https://vercel.com
3. Import the repository
4. Add these environment variables in Project Settings → Environment Variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `JWT_SECRET`
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL` (set to `gpt-4o-mini`)
5. Deploy

### Option B: Vercel CLI

```bash
npx vercel
```

Then add the same environment variables in the Vercel dashboard.

## 6) Install Daybook on your iPhone

1. Open the deployed HTTPS URL in Safari
2. Tap the Share button
3. Tap Add to Home Screen
4. Open it from the home screen icon

This makes it behave like an app.

## 7) Important notes for this prototype

- This is a cheap prototype, not a production-grade auth system.
- The password reset question is intentionally simple: it accepts only the answer `me`.
- Session persistence is done with a saved token in localStorage for convenience.
- This is acceptable for a prototype, but a real app should use secure HTTP-only cookies and stronger auth patterns.

## 8) What changes to expect

The app now:

- shows a login screen when no user is signed in
- creates an account with username/password plus the custom question
- signs in and keeps the user logged in on the same device
- allows password reset with the custom question
- stores tasks/calendar/friends/notes in the database instead of browser localStorage
- provides a floating assistant that remembers recent conversation and can manage Daybook data

## 9) Using the assistant

Click the floating sparkle button after signing in. You can type or use browser speech input. The assistant can create tasks/reminders, events, friends, contact logs, voice notes, and classes; complete tasks; list your Daybook data; and change display settings.

The assistant uses the OpenAI Responses API (`POST https://api.openai.com/v1/responses`) with custom function tools on the Vercel server. The browser never receives `OPENAI_API_KEY`. Conversation history is stored in Supabase and limited to the most recent messages sent to the model to control cost and latency. The app manages its own conversation record in Supabase and uses `store: false` for OpenAI responses.

For this prototype, `gpt-4o-mini` is the recommended OpenAI model because it is fast, inexpensive, and supports structured tool calls through Responses. Set `OPENAI_MODEL` to another Responses-compatible tool-capable OpenAI model later without changing the UI. Do not use the retired Assistants API.

## 10) What you need next

You may want to add:

- email verification
- a proper forgot-password email flow
- better password hashing or cookie sessions
- a nicer UI
- multi-device sync polish

But for a prototype, this setup is cheap, practical, and deployable.

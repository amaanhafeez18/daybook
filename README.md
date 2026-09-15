# Daybook

A personal PWA: tasks, calendar, friends (last-contact tracking), and voice notes.
Everything is stored in the browser (`localStorage`) — no account, no backend, works offline once installed.

## Run it locally

```bash
npm install
npm run dev
```

Open the printed `localhost` URL. Note: speech-to-text (Voice tab) and installability need `https`,
so it won't fully work over plain `http://localhost` in every browser — deploy to Vercel to test
those properly (see below), or use `npm run build && npm run preview`.

## Deploy to Vercel (free)

**Option A — GitHub (recommended):**
1. Create a new GitHub repo and push this folder to it:
   ```bash
   git init
   git add .
   git commit -m "Daybook PWA"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/daybook.git
   git push -u origin main
   ```
2. Go to [vercel.com](https://vercel.com), sign in with GitHub, click **Add New → Project**, and import the repo.
3. Vercel auto-detects Vite — leave the defaults and click **Deploy**.
4. You'll get a live `https://your-project.vercel.app` URL in about a minute.

**Option B — Vercel CLI (no GitHub needed):**
```bash
npm install -g vercel
vercel
```
Follow the prompts (link or create a project). It deploys straight from this folder.

## Install it on your iPhone

1. Open your deployed `https://...vercel.app` URL in **Safari** (must be Safari, not Chrome, for install to show up).
2. Tap the Share icon → **Add to Home Screen**.
3. Open it from the home screen icon — it now runs full-screen, like an app.

## What's here / next steps

- **Tasks, Calendar, Friends**: fully working, data persists on-device via `localStorage`.
- **Voice notes**: uses the browser's built-in speech recognition where supported (Chrome/Edge, Android).
  Safari on iOS doesn't support this API, so on iPhone it falls back to a text field — use the
  microphone key on the iOS keyboard to dictate into it, which works just as well in practice.
- **Not yet included**: syncing across devices, and AI-powered note parsing (e.g. auto-turning a
  voice note into a task). Both would need a small backend — Supabase is the natural next step,
  plus an API like OpenAI Whisper or Deepgram if you want real audio-file transcription instead of
  the browser API.

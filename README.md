# Daybook

A lightweight personal organizer prototype with:

- username/password login
- persistent login on the same device
- data shared across devices through a backend
- tasks, calendar, friends tracking, and voice notes
- deployment on Vercel

This is a cheap prototype designed to get you a working multi-device app quickly.

## Stack

- Frontend: React + Vite
- Deployment: Vercel
- Database: Supabase Postgres
- Auth: custom username/password flow + signed JWT token stored in localStorage for prototype persistence

## Run locally

1. Create a `.env.local` file from `.env.example`
2. Fill in the Supabase values
3. Run:

```bash
npm install
npm run dev
```

This starts the Vercel local environment so the API routes work correctly.

## Configure Supabase

1. Create a Supabase project
2. Open SQL Editor
3. Run the SQL from `supabase/schema.sql`
4. Copy the project URL and service role key into `.env.local`

## Deploy to Vercel

1. Push this folder to GitHub
2. Import it into Vercel
3. Add environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `JWT_SECRET`
4. Deploy

## Install it on iPhone

1. Open the Vercel HTTPS URL in Safari
2. Tap the Share button
3. Choose Add to Home Screen
4. Open it from the home screen

## Prototype auth flow

This app supports:

- sign up with username + password
- login with username + password
- persistent login token stored locally
- forgot password flow using the question: "What is that you are worried about?"
- answer must be `me` to reset the password immediately

## Important note

This is a prototype to keep costs low and get a working app fast. It is not production-grade security. For a real product, you would normally move to secure HTTP-only cookies and stronger auth patterns.


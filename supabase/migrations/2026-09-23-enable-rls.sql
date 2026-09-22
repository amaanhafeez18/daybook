-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- SECURITY: turns on Row Level Security for every Daybook table. With RLS on and no policies,
-- the public (publishable / anon) key can no longer read or change anything. The app's server
-- uses the SECRET key, which bypasses RLS, so the app keeps working.
--
-- BEFORE running this, make sure Vercel's SUPABASE_SERVICE_ROLE_KEY is the secret key
-- (starts with sb_secret_, or the legacy "service_role" key). If it is the publishable key,
-- the live app will stop working until it is replaced.

alter table if exists public.users enable row level security;
alter table if exists public.tasks enable row level security;
alter table if exists public.events enable row level security;
alter table if exists public.friends enable row level security;
alter table if exists public.contact_logs enable row level security;
alter table if exists public.voice_notes enable row level security;
alter table if exists public.classes enable row level security;
alter table if exists public.settings enable row level security;
alter table if exists public.assistant_conversations enable row level security;
alter table if exists public.journal_entries enable row level security;
alter table if exists public.assistant_memories enable row level security;

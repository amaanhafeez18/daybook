-- Run once in the Supabase SQL editor. Safe to re-run.
-- Enables lockout after repeated wrong passwords / recovery answers.
-- The app works without these columns; lockout is simply skipped until they exist.

alter table public.users add column if not exists failed_attempts integer not null default 0;
alter table public.users add column if not exists locked_until timestamptz;

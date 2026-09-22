-- Run once in the Supabase SQL editor. Safe to re-run.
-- Adds columns the app already sends but older databases never got,
-- which made saving a new friend or class fail.

alter table public.friends add column if not exists note text;
alter table public.friends add column if not exists photo_url text;
alter table public.friends add column if not exists birthday text;
alter table public.friends add column if not exists current_status text;
alter table public.friends add column if not exists facts text;

alter table public.classes add column if not exists time text;
alter table public.classes add column if not exists room text;
alter table public.classes add column if not exists day_details jsonb not null default '{}'::jsonb;

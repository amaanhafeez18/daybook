-- Run once in the Supabase SQL editor (safe to re-run).
-- Gym tracker: one row per logged workout, plus a body-weight log. Routines, the schedule and gym
-- preferences live in the settings row (settings.value.gym), so they need no table.
-- Until this has run, the app still loads (gym lists come back empty) but gym data can't sync.
-- It also adds patch_settings, which saves settings changes without one device undoing another's.

-- Logged workouts. exercises = [{ id, exerciseId, name, tracking, restSec, note, supersetId, sets: [...] }],
-- planned = { versionId, routineId, cycleIndex } snapshot of the schedule when the workout started.
create table if not exists public.gym_sessions (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  date text not null,
  name text,
  routine_id text,
  started_at text,
  ended_at text,
  duration_sec integer,
  exercises jsonb not null default '[]'::jsonb,
  note text,
  planned jsonb,
  bodyweight_kg double precision,
  is_deload boolean not null default false,
  created_at timestamptz not null default now()
);

-- Body-weight log (kg at full precision; the app converts for display).
create table if not exists public.body_weights (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  date text not null,
  kg double precision not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_gym_sessions_user_id on public.gym_sessions(user_id);
create index if not exists idx_gym_sessions_user_date on public.gym_sessions(user_id, date);
create index if not exists idx_body_weights_user_id on public.body_weights(user_id);
create index if not exists idx_body_weights_user_date on public.body_weights(user_id, date);

-- Same as every other Daybook table: RLS on with no policies, so only the server's secret key
-- can read or write these rows (see 2026-09-23-enable-rls.sql).
alter table public.gym_sessions enable row level security;
alter table public.body_weights enable row level security;

-- Saves a settings change in one locked step, so a phone saving its active workout and the assistant
-- changing the schedule at the same moment can't undo each other. Same rules as api/data.js: each
-- field in p_patch replaces the saved one, except an object over an object (gym, notifications),
-- which merges one level deep. Creates the row if there is none and removes duplicate rows.
-- The API falls back to its older read-modify-write until this function exists.
create or replace function public.patch_settings(p_user uuid, p_patch jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  patch jsonb := case when jsonb_typeof(p_patch) = 'object' then p_patch else '{}'::jsonb end;
  settings_id text;
  saved jsonb;
begin
  -- One save per user at a time, even before the user has a settings row.
  perform pg_advisory_xact_lock(hashtextextended('daybook.settings:' || p_user::text, 0));

  select s.id, s.value into settings_id, saved
    from public.settings s
   where s.user_id = p_user
   order by s.created_at desc, s.id
   limit 1
   for update;

  if settings_id is null then
    insert into public.settings (id, user_id, value, created_at)
    values (gen_random_uuid()::text, p_user, patch, now());
    return;
  end if;

  if jsonb_typeof(saved) is distinct from 'object' then
    saved := '{}'::jsonb;
  end if;

  update public.settings s
     set value = saved || coalesce((
           select jsonb_object_agg(p.key, case
                    when jsonb_typeof(saved -> p.key) = 'object' and jsonb_typeof(p.value) = 'object' then (saved -> p.key) || p.value
                    else p.value
                  end)
             from jsonb_each(patch) p
         ), '{}'::jsonb)
   where s.id = settings_id;

  delete from public.settings s where s.user_id = p_user and s.id <> settings_id;
end;
$$;

-- Only the server (secret key) may call it.
revoke all on function public.patch_settings(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.patch_settings(uuid, jsonb) to service_role;

-- Let the API see the new tables and function straight away.
notify pgrst, 'reload schema';

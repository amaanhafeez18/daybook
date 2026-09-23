create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  recovery_question text not null default 'What is that you are worried about?',
  recovery_answer text not null,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  token_version integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  text text not null,
  done boolean not null default false,
  date text,
  time text,
  details text,
  priority text not null default 'medium',
  archived boolean not null default false,
  calendar_event_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  date text not null,
  time text,
  title text not null,
  task_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.friends (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  relationship text not null default 'friend',
  reminder_days integer,
  organization text,
  note text,
  photo_url text,
  birthday text,
  current_status text,
  facts text,
  created_at timestamptz not null default now()
);

create table if not exists public.contact_logs (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  friend_id text not null,
  date text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.voice_notes (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.classes (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  days jsonb not null default '[]'::jsonb,
  time text,
  room text,
  end_date text,
  day_details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.assistant_conversations (
  id text primary key,
  user_id uuid not null unique references public.users(id) on delete cascade,
  messages jsonb not null default '[]'::jsonb,
  usage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.assistant_memories (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.journal_entries (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  date text not null,
  title text not null default 'Untitled entry',
  body text not null default '',
  mood text,
  created_at timestamptz not null default now()
);

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

create table if not exists public.body_weights (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  date text not null,
  kg double precision not null,
  created_at timestamptz not null default now()
);

alter table public.users add column if not exists failed_attempts integer not null default 0;
alter table public.users add column if not exists locked_until timestamptz;
alter table public.users add column if not exists token_version integer not null default 0;
alter table public.assistant_conversations add column if not exists usage jsonb not null default '{}'::jsonb;
alter table public.tasks add column if not exists date text;
alter table public.tasks add column if not exists time text;
alter table public.tasks add column if not exists details text;
alter table public.tasks add column if not exists priority text not null default 'medium';
alter table public.tasks add column if not exists archived boolean not null default false;
alter table public.tasks add column if not exists calendar_event_id text;
alter table public.events add column if not exists task_id text;
alter table public.friends add column if not exists reminder_days integer;
alter table public.classes add column if not exists end_date text;
alter table public.friends add column if not exists relationship text not null default 'friend';
alter table public.friends add column if not exists organization text;
alter table public.friends add column if not exists note text;
alter table public.friends add column if not exists photo_url text;
alter table public.friends add column if not exists birthday text;
alter table public.friends add column if not exists current_status text;
alter table public.friends add column if not exists facts text;
alter table public.classes add column if not exists time text;
alter table public.classes add column if not exists room text;
alter table public.classes add column if not exists day_details jsonb not null default '{}'::jsonb;

create index if not exists idx_tasks_user_id on public.tasks(user_id);
create index if not exists idx_events_user_id on public.events(user_id);
create index if not exists idx_friends_user_id on public.friends(user_id);
create index if not exists idx_contact_logs_user_id on public.contact_logs(user_id);
create index if not exists idx_voice_notes_user_id on public.voice_notes(user_id);
create index if not exists idx_classes_user_id on public.classes(user_id);
create index if not exists idx_settings_user_id on public.settings(user_id);
create index if not exists idx_assistant_conversations_user_id on public.assistant_conversations(user_id);
create index if not exists idx_journal_entries_user_id on public.journal_entries(user_id);
create index if not exists idx_assistant_memories_user_id on public.assistant_memories(user_id);
create index if not exists idx_gym_sessions_user_id on public.gym_sessions(user_id);
create index if not exists idx_gym_sessions_user_date on public.gym_sessions(user_id, date);
create index if not exists idx_body_weights_user_id on public.body_weights(user_id);
create index if not exists idx_body_weights_user_date on public.body_weights(user_id, date);

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

-- Login throttling helpers and Row Level Security: see supabase/migrations/2026-09-23-auth-hardening.sql
-- and supabase/migrations/2026-09-23-enable-rls.sql (both are required for a secure setup).
-- Push notifications (devices, sent-reminder log, per-task reminder, every-minute scheduler):
-- see supabase/migrations/2026-09-24-notifications.sql.
-- Gym tables above also need Row Level Security: see supabase/migrations/2026-09-26-gym.sql.

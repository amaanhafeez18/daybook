-- Run once in the Supabase SQL editor. Safe to re-run.
-- Login protection and usage limits. The app works without these; each feature is simply
-- skipped until its column/function exists.

-- Account lockout after repeated wrong passwords / recovery answers.
alter table public.users add column if not exists failed_attempts integer not null default 0;
alter table public.users add column if not exists locked_until timestamptz;

-- Bumped on password change/reset so every other device is signed out.
alter table public.users add column if not exists token_version integer not null default 0;

-- Counts a failed attempt atomically (parallel guesses can't slip past the limit).
create or replace function public.daybook_record_auth_failure(p_user_id uuid, p_max integer, p_lock_minutes integer)
returns void
language sql
security definer
set search_path = public
as $$
  update public.users
     set locked_until = case when failed_attempts + 1 >= p_max then now() + make_interval(mins => p_lock_minutes) else locked_until end,
         failed_attempts = case when failed_attempts + 1 >= p_max then 0 else failed_attempts + 1 end
   where id = p_user_id;
$$;

-- Per-IP rate limiting for login, recovery and sign-up.
create table if not exists public.auth_throttle (
  key text primary key,
  attempts integer not null default 0,
  window_start timestamptz not null default now()
);
alter table public.auth_throttle enable row level security;

-- Fixed window: returns true while `p_key` has made at most p_limit calls in p_window_seconds.
create or replace function public.daybook_throttle(p_key text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_attempts integer;
begin
  insert into public.auth_throttle as t (key, attempts, window_start)
  values (p_key, 1, now())
  on conflict (key) do update
    set attempts = case when t.window_start < now() - make_interval(secs => p_window_seconds) then 1 else t.attempts + 1 end,
        window_start = case when t.window_start < now() - make_interval(secs => p_window_seconds) then now() else t.window_start end
  returning attempts into current_attempts;
  return current_attempts <= p_limit;
end;
$$;

-- Only the server (secret key) may call these.
revoke execute on function public.daybook_record_auth_failure(uuid, integer, integer) from public, anon, authenticated;
revoke execute on function public.daybook_throttle(text, integer, integer) from public, anon, authenticated;
grant execute on function public.daybook_record_auth_failure(uuid, integer, integer) to service_role;
grant execute on function public.daybook_throttle(text, integer, integer) to service_role;

-- Daily assistant message count (caps OpenAI spend per account).
alter table public.assistant_conversations add column if not exists usage jsonb not null default '{}'::jsonb;

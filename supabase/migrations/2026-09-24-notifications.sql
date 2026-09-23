-- Run once in the Supabase SQL editor (part 1 is safe to re-run).

-- ---- Part 1: tables ---------------------------------------------------------------------------

-- Devices that turned notifications on.
create table if not exists public.push_subscriptions (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  vapid_public text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz
);
create index if not exists idx_push_subscriptions_user_id on public.push_subscriptions(user_id);

-- Which reminders were already sent (stops duplicates).
create table if not exists public.notification_log (
  user_id uuid not null references public.users(id) on delete cascade,
  key text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- Per-task reminder override: null = use settings, -1 = none, otherwise minutes before
-- (tasks without a time: 0 = on the day, 1440 = the day before).
alter table public.tasks add column if not exists reminder_minutes integer;

alter table public.push_subscriptions enable row level security;
alter table public.notification_log enable row level security;

-- ---- Part 2: run the reminder check every minute ----------------------------------------------
-- Replace YOUR_CRON_SECRET with the same value as CRON_SECRET in Vercel, and the URL if yours differs.
-- Run history is purged by 2026-09-25-cron-log-cleanup.sql (kept separate so it can be re-run without the secret).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('daybook-reminders') where exists (select 1 from cron.job where jobname = 'daybook-reminders');
select cron.schedule(
  'daybook-reminders',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://daybook-smoky-seven.vercel.app/api/cron',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer YOUR_CRON_SECRET"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

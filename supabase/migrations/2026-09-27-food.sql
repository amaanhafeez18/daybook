-- Run once in the Supabase SQL editor (safe to re-run).
-- Food tracker: one row per logged food or drink. Goals, the calculator profile, food preferences and
-- favorites live in the settings row (settings.value.food), so they need no table. Body weight uses
-- the body_weights table from 2026-09-26-gym.sql.
-- Until this has run, the app still loads (the food list comes back empty) but food data can't sync.
-- It also adds an optional note to catch-up logs ("what we talked about").

-- Logged food. Energy is in kcal and nutrients in grams (sodium in mg); null means "not known".
-- extra = { alcoholG, caffeineMg, satFatG, ... } for nutrients without a column,
-- ai = { query, confidence, assumptions: [], model } when the entry came from an AI estimate.
create table if not exists public.food_entries (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  date text not null,
  time text,
  meal text,
  name text,
  brand text,
  amount double precision,
  unit text,
  grams double precision,
  calories double precision,
  protein_g double precision,
  carbs_g double precision,
  fat_g double precision,
  fiber_g double precision,
  sugar_g double precision,
  sodium_mg double precision,
  extra jsonb not null default '{}'::jsonb,
  note text,
  source text not null default 'manual',
  favorite_id text,
  ai jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_food_entries_user_id on public.food_entries(user_id);
create index if not exists idx_food_entries_user_date on public.food_entries(user_id, date);

-- Same as every other Daybook table: RLS on with no policies, so only the server's secret key
-- can read or write these rows (see 2026-09-23-enable-rls.sql).
alter table public.food_entries enable row level security;

-- A short note on a catch-up. The app saves without it until this column exists.
alter table public.contact_logs add column if not exists note text;

-- Let the API see the new table and column straight away.
notify pgrst, 'reload schema';

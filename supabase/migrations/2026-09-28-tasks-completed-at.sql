-- Run once in the Supabase SQL editor (safe to re-run; needs no secrets).
-- When a task was ticked off, so "what did I get done today / this week?" can be answered.
-- The app and the assistant work without it (the field is simply not saved until it exists).

alter table public.tasks add column if not exists completed_at timestamptz;

-- Let the API see the new column straight away.
notify pgrst, 'reload schema';

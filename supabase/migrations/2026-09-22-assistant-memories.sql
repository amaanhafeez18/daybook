-- Run once in the Supabase SQL editor. Safe to re-run.
-- Long-term memory for the Daybook assistant: short facts the user has told it.

create table if not exists public.assistant_memories (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_assistant_memories_user_id on public.assistant_memories(user_id);

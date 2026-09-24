-- Run once in the Supabase SQL editor (safe to re-run; needs no secrets).
-- Photos and files pinned to a task, a note or a person ("save this photo to the dentist task").
-- The file itself lives in the private assistant-uploads bucket under <user>/keep/…, which the
-- nightly cleanup leaves alone. The app and the assistant work without this table (attaching
-- explains that it isn't set up yet).

create table if not exists public.attachments (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  target_type text not null check (target_type in ('task', 'note', 'friend')),
  target_id text not null,
  path text not null,
  name text not null,
  kind text not null default 'image',
  bytes integer,
  caption text,
  created_at timestamptz not null default now()
);

create index if not exists idx_attachments_user_id on public.attachments(user_id);
create index if not exists idx_attachments_user_target on public.attachments(user_id, target_type, target_id);

-- Only the server (secret key) reads or writes it.
alter table public.attachments enable row level security;

-- Let the API see the new table straight away.
notify pgrst, 'reload schema';

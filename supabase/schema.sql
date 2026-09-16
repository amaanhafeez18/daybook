create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  recovery_question text not null default 'What is that you are worried about?',
  recovery_answer text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  text text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  date text not null,
  time text,
  title text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.friends (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  note text,
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

create index if not exists idx_tasks_user_id on public.tasks(user_id);
create index if not exists idx_events_user_id on public.events(user_id);
create index if not exists idx_friends_user_id on public.friends(user_id);
create index if not exists idx_contact_logs_user_id on public.contact_logs(user_id);
create index if not exists idx_voice_notes_user_id on public.voice_notes(user_id);

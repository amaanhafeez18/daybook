create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  recovery_question text not null default 'What is that you are worried about?',
  recovery_answer text not null,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
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

alter table public.users add column if not exists failed_attempts integer not null default 0;
alter table public.users add column if not exists locked_until timestamptz;
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
